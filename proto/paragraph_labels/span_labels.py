"""Span-level labels for transcripts: the stored format and a paragraph splitter.

Labels are stored in a score's metadata under `span_labels`, as
`SpanLabels(...).model_dump()`. Each span points at a range of one content part
of one message: `message_id` and `content_index` find the part, and `start` and
`end` are Unicode code-point offsets (Python `str` indices) into the part's
text, which is `ContentReasoning.reasoning` for reasoning parts and
`ContentText.text` for text parts.
"""

import re
from collections.abc import Collection, Sequence
from typing import Literal, NamedTuple, get_args

from pydantic import BaseModel, model_validator

from inspect_ai.model import (
    ChatMessage,
    ChatMessageAssistant,
    Content,
    ContentReasoning,
    ContentText,
)

PARAGRAPH_BREAK = re.compile(r"\n\s*\n")
"""A blank line, which may hold other whitespace, ends a paragraph."""

ContentType = Literal["reasoning", "text"]
"""Content parts whose text can be labelled."""

REASONING: tuple[ContentType, ...] = ("reasoning",)
"""Label reasoning parts only (the default)."""


class LabelQuestion(BaseModel):
    """A question asked about every span, with its possible answers."""

    name: str
    """Name of the question, unique among the questions."""

    description: str | None = None
    """What the question asks."""

    options: list[str]
    """Possible answers (at least two). Yes/no questions use `["yes", "no"]`."""

    @model_validator(mode="after")
    def _check_options(self) -> "LabelQuestion":
        if len(self.options) < 2:
            raise ValueError(
                f"Question '{self.name}' needs at least two options, got {self.options}"
            )
        if len(set(self.options)) != len(self.options):
            raise ValueError(
                f"Question '{self.name}' has repeated options: {self.options}"
            )
        return self


class LabelledSpan(BaseModel):
    """A labelled range of the text of one content part of one message."""

    message_id: str
    """`ChatMessage.id` of the message."""

    content_index: int
    """Index of the part in the message's content list."""

    start: int
    """Code-point offset into the part's text where the span starts (inclusive)."""

    end: int
    """Code-point offset into the part's text where the span ends (exclusive)."""

    labels: dict[str, str]
    """Question name to the chosen option (the most probable one)."""

    probabilities: dict[str, dict[str, float]]
    """Question name to the probability of each of its options."""

    @model_validator(mode="after")
    def _check_range(self) -> "LabelledSpan":
        if self.content_index < 0 or not 0 <= self.start < self.end:
            raise ValueError(
                f"Span of message {self.message_id} has an invalid range: "
                f"content_index={self.content_index}, [{self.start}, {self.end})"
            )
        return self


class SpanLabels(BaseModel):
    """The labelled spans of one sample, and the questions they answer."""

    version: Literal[0] = 0
    """Version of this format."""

    unit: str
    """What a span is, e.g. "paragraph"."""

    classifier: str
    """What produced the labels, e.g. "random" or "typesafe/jev-1.14"."""

    questions: list[LabelQuestion]
    """Questions asked about every span."""

    spans: list[LabelledSpan]
    """Labelled spans, in transcript order."""

    @model_validator(mode="after")
    def _check_spans(self) -> "SpanLabels":
        names = [question.name for question in self.questions]
        if not names:
            raise ValueError("SpanLabels needs at least one question")
        if len(set(names)) != len(names):
            raise ValueError(f"Question names are repeated: {names}")
        last_end: dict[tuple[str, int], int] = {}
        for span in self.spans:
            where = f"span [{span.start}, {span.end}) of message {span.message_id}"
            if set(span.labels) != set(names) or set(span.probabilities) != set(names):
                raise ValueError(
                    f"Questions of {where} don't match {names}: labels "
                    f"{sorted(span.labels)}, probabilities {sorted(span.probabilities)}"
                )
            for question in self.questions:
                check_probabilities(question, span.probabilities[question.name])
                if span.labels[question.name] not in question.options:
                    raise ValueError(
                        f"Label '{span.labels[question.name]}' of {where} isn't an "
                        f"option of '{question.name}': {question.options}"
                    )
            part = (span.message_id, span.content_index)
            if span.start < last_end.get(part, 0):
                raise ValueError(
                    f"The {where} (part {span.content_index}) overlaps or comes "
                    "before the previous span of that part"
                )
            last_end[part] = span.end
        return self


def check_probabilities(
    question: LabelQuestion, probabilities: dict[str, float]
) -> None:
    """Check one span's probabilities for a question.

    They must cover exactly the question's options, lie in [0, 1], and sum to
    1 up to rounding each probability to two decimals.

    Raises:
        ValueError: If the probabilities break any of these rules.
    """
    if set(probabilities) != set(question.options):
        raise ValueError(
            f"Probabilities for '{question.name}' cover {sorted(probabilities)}, "
            f"not its options {question.options}"
        )
    if not all(0.0 <= p <= 1.0 for p in probabilities.values()):
        raise ValueError(
            f"Probabilities for '{question.name}' aren't all in [0, 1]: {probabilities}"
        )
    tolerance = 0.005 * len(question.options) + 1e-9
    if abs(sum(probabilities.values()) - 1.0) > tolerance:
        raise ValueError(
            f"Probabilities for '{question.name}' don't sum to 1: {probabilities}"
        )


class TextRange(NamedTuple):
    """A [start, end) range of code points in a string."""

    start: int
    end: int


class Paragraph(NamedTuple):
    """A paragraph of one content part of one message."""

    message_id: str
    content_index: int
    start: int
    end: int
    text: str


def check_span_text(text: str, start: int, end: int) -> None:
    """Check that `text[start:end]` is non-empty and has no surrounding whitespace.

    Raises:
        ValueError: If the range is outside `text`, empty, or starts or ends
            with whitespace.
    """
    if not 0 <= start < end <= len(text):
        raise ValueError(
            f"Span [{start}, {end}) is empty or outside text of length {len(text)}"
        )
    piece = text[start:end]
    if piece != piece.strip():
        raise ValueError(
            f"Span [{start}, {end}) starts or ends with whitespace: {piece[:60]!r}"
        )


def paragraph_ranges(text: str) -> list[TextRange]:
    """Where each paragraph of `text` lies in it.

    Gives the same paragraphs as splitting `text` on `PARAGRAPH_BREAK`,
    stripping each piece and dropping empty ones, but as ranges of `text`.
    """
    bounds = [0]
    for match in PARAGRAPH_BREAK.finditer(text):
        bounds += [match.start(), match.end()]
    bounds.append(len(text))
    ranges: list[TextRange] = []
    for piece_start, piece_end in zip(bounds[::2], bounds[1::2], strict=True):
        piece = text[piece_start:piece_end]
        stripped = piece.strip()
        if stripped:
            start = piece_start + len(piece) - len(piece.lstrip())
            ranges.append(TextRange(start, start + len(stripped)))
    previous_end = 0
    for start, end in ranges:
        check_span_text(text, start, end)
        if start < previous_end:
            raise ValueError(f"Paragraph [{start}, {end}) overlaps the one before")
        previous_end = end
    return ranges


def part_text(part: Content, content_types: Collection[ContentType]) -> str | None:
    """The text of a content part to label, or None if the part isn't labelled.

    Redacted reasoning is never labelled, since its text is encrypted.
    """
    if (
        isinstance(part, ContentReasoning)
        and "reasoning" in content_types
        and not part.redacted
    ):
        return part.reasoning
    if isinstance(part, ContentText) and "text" in content_types:
        return part.text
    return None


def message_paragraphs(
    messages: Sequence[ChatMessage],
    content_types: Collection[ContentType] = REASONING,
) -> list[Paragraph]:
    """The paragraphs of every assistant message, in order.

    Only messages whose content is a list of parts are read, since a span
    names its part by index. Within those, each part of the given types is
    split with `paragraph_ranges`.

    Args:
        messages: Messages of the transcript.
        content_types: Kinds of part to split (reasoning only by default).

    Raises:
        ValueError: If `content_types` names an unknown kind of part, or a
            message with paragraphs has no id or the same id as an earlier one.
    """
    unknown = set(content_types) - set(get_args(ContentType))
    if unknown:
        raise ValueError(f"Unknown content types: {sorted(unknown)}")
    paragraphs: list[Paragraph] = []
    labelled_ids: set[str] = set()
    for message in messages:
        if not isinstance(message, ChatMessageAssistant) or isinstance(
            message.content, str
        ):
            continue
        found: list[tuple[int, str, TextRange]] = []
        for content_index, part in enumerate(message.content):
            text = part_text(part, content_types)
            if text is not None:
                found += [(content_index, text, r) for r in paragraph_ranges(text)]
        if not found:
            continue
        if message.id is None:
            raise ValueError("An assistant message with paragraphs to label has no id")
        if message.id in labelled_ids:
            raise ValueError(f"Two labelled messages have the same id: {message.id}")
        labelled_ids.add(message.id)
        paragraphs += [
            Paragraph(message.id, content_index, r.start, r.end, text[r.start : r.end])
            for content_index, text, r in found
        ]
    return paragraphs
