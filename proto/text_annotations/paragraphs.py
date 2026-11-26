"""Splitting the reasoning of a transcript into paragraphs.

The splitter matches the reference project's (split on `PARAGRAPH_BREAK`,
strip each piece, drop empty ones), but gives each paragraph's code-point
range in its text rather than a copy of the paragraph.
"""

import re
from collections.abc import Collection, Sequence
from typing import NamedTuple, get_args

from inspect_ai.model import ChatMessage

from .annotations import REASONING, ContentType, TextRange, text_parts

PARAGRAPH_BREAK = re.compile(r"\n\s*\n")
"""A blank line, which may hold other whitespace, ends a paragraph."""


class Paragraph(NamedTuple):
    """A paragraph of one text part of one message."""

    message_id: str
    content_index: int | None
    """None if the message's content is a string."""
    start: int
    end: int
    text: str


def check_paragraph(text: str, start: int, end: int) -> None:
    """Check that `text[start:end]` is non-empty and has no surrounding whitespace.

    Raises:
        ValueError: If the range is outside `text`, empty, or starts or ends
            with whitespace.
    """
    if not 0 <= start < end <= len(text):
        raise ValueError(
            f"Paragraph [{start}, {end}) is empty or outside text of length {len(text)}"
        )
    piece = text[start:end]
    if piece != piece.strip():
        raise ValueError(f"Paragraph [{start}, {end}) starts or ends with whitespace")


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
        check_paragraph(text, start, end)
        if start < previous_end:
            raise ValueError(f"Paragraph [{start}, {end}) overlaps the one before")
        previous_end = end
    return ranges


def message_paragraphs(
    messages: Sequence[ChatMessage],
    content_types: Collection[ContentType] = REASONING,
) -> list[Paragraph]:
    """The paragraphs of the assistant messages, in transcript order.

    Each of the assistant messages' `text_parts` of the given types is split
    with `paragraph_ranges`. Other roles' messages are not split.

    Args:
        messages: Messages of the transcript.
        content_types: Kinds of part to split (reasoning only by default).

    Raises:
        ValueError: If `content_types` names an unknown kind of part, or a
            message with text has no id or the same id as an earlier one.
    """
    check_content_types(content_types)
    return [
        Paragraph(part.message_id, part.content_index, start, end, part.text[start:end])
        for part in text_parts(messages)
        if part.role == "assistant" and part.content_type in content_types
        for start, end in paragraph_ranges(part.text)
    ]


def check_content_types(content_types: Collection[str]) -> None:
    """Check that every content type is one of `ContentType`.

    Raises:
        ValueError: If one isn't.
    """
    unknown = set(content_types) - set(get_args(ContentType))
    if unknown:
        raise ValueError(f"Unknown content types: {sorted(unknown)}")
