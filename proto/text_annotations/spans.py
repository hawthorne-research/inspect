"""Spans of transcript text: ranges of a message part's text to give values to.

`paragraph_spans` and `token_spans` find spans in a transcript's messages.
Both give `Span`s, so any annotator can use either (see `SpanFinder`).

The paragraph splitter matches the reference project's (split on
`PARAGRAPH_BREAK`, strip each piece, drop empty ones), but gives each
paragraph's code-point range in its text rather than a copy of the paragraph.
"""

import re
from collections.abc import Callable, Collection, Sequence
from itertools import pairwise
from typing import NamedTuple, get_args

import tiktoken

from inspect_ai.model import ChatMessage

from .annotations import REASONING, ContentType, TextRange, describe_part, text_parts

PARAGRAPH_BREAK = re.compile(r"\n\s*\n")
"""A blank line, which may hold other whitespace, ends a paragraph."""


class Span(NamedTuple):
    """A [start, end) range of code points in the text of one message part."""

    message_id: str
    content_index: int | None
    """None if the message's content is a string."""
    start: int
    end: int


SpanFinder = Callable[[Sequence[ChatMessage]], list[Span]]
"""Gives the spans of a transcript's messages, in transcript order."""


def span_texts(spans: Sequence[Span], messages: Sequence[ChatMessage]) -> list[str]:
    """The text of each span.

    Raises:
        ValueError: If a span isn't in one of the messages' `text_parts` or
            isn't a non-empty range of its text.
    """
    texts = {(p.message_id, p.content_index): p.text for p in text_parts(messages)}
    result: list[str] = []
    for span in spans:
        where = describe_part(span.message_id, span.content_index)
        text = texts.get((span.message_id, span.content_index))
        if text is None:
            raise ValueError(f"The {where} isn't a text part of the messages")
        if not 0 <= span.start < span.end <= len(text):
            raise ValueError(
                f"Span [{span.start}, {span.end}) of the {where} is empty or outside "
                f"its text of length {len(text)}"
            )
        result.append(text[span.start : span.end])
    return result


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


def paragraph_spans(
    messages: Sequence[ChatMessage],
    content_types: Collection[ContentType] = REASONING,
) -> list[Span]:
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
        Span(part.message_id, part.content_index, start, end)
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


def check_covers(text: str, offsets: Sequence[TextRange]) -> None:
    """Check that tokens are non-empty and cover `text` exactly, in order.

    Then `"".join(text[start:end] for start, end in offsets) == text`.

    Raises:
        ValueError: If a token is empty or doesn't start where the one
            before it ends, or the tokens don't start at 0 and end at the
            end of the text.
    """
    position = 0
    for index, (start, end) in enumerate(offsets):
        if start != position or end <= start:
            raise ValueError(
                f"Token {index} [{start}, {end}) is empty or doesn't start where "
                f"the token before it ends ({position})"
            )
        position = end
    if position != len(text):
        raise ValueError(
            f"Tokens end at {position}, not at the end of the text ({len(text)})"
        )


def token_offsets(text: str, encoding: str = "o200k_base") -> list[TextRange]:
    """Where each token of `text` lies in it, using a tiktoken encoding.

    tiktoken gives each token the offset of the character its first byte
    belongs to, so when one character is split over several tokens, those
    tokens share a start. They are merged into one token, so that no token
    is empty. Special-token text such as "<|endoftext|>" is encoded as
    ordinary text.

    Args:
        text: Text to tokenise.
        encoding: Name of the tiktoken encoding.

    Raises:
        ValueError: If the tokens don't decode to `text` (e.g. it has lone
            surrogates) or don't cover it exactly.
    """
    tokenizer = tiktoken.get_encoding(encoding)
    decoded, starts = tokenizer.decode_with_offsets(
        tokenizer.encode(text, disallowed_special=())
    )
    if decoded != text:
        raise ValueError(
            f"Tokens of a text of length {len(text)} decode to a different text"
        )
    bounds = [*dict.fromkeys(starts), len(text)]
    offsets = [TextRange(start, end) for start, end in pairwise(bounds)]
    check_covers(text, offsets)
    return offsets


def token_spans(
    messages: Sequence[ChatMessage], encoding: str = "o200k_base"
) -> list[Span]:
    """The tokens of every message's `text_parts`, in transcript order.

    Each part is tokenised with `token_offsets`, so its tokens cover its text.

    Args:
        messages: Messages of the transcript.
        encoding: Name of the tiktoken encoding.

    Raises:
        ValueError: If a message with text has no id or the same id as an
            earlier one, or a part's tokens don't cover its text.
    """
    return [
        Span(part.message_id, part.content_index, start, end)
        for part in text_parts(messages)
        for start, end in token_offsets(part.text, encoding)
    ]
