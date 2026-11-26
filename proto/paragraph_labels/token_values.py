"""Per-token values from probes: the stored format, text parts and tokenisation.

Values are stored in a score's metadata under `token_values`, as
`TokenValues(...).model_dump()`. Each part points at the text of one message:
`message_id` and `content_index` find the text, and `starts` and `ends` are
Unicode code-point offsets (Python `str` indices) into it, one pair per token.
The text is `ContentText.text` for text parts, `ContentReasoning.reasoning` for
reasoning parts, and the message's `content` when that is a string (then
`content_index` is None).
"""

import math
from collections.abc import Sequence
from itertools import pairwise
from typing import Literal, NamedTuple

import tiktoken
from pydantic import BaseModel, model_validator

from inspect_ai.model import ChatMessage

from .span_labels import ContentType, TextRange, part_text

TEXT_CONTENT: tuple[ContentType, ...] = ("reasoning", "text")
"""Content parts that get token values."""


class TokenProbe(BaseModel):
    """A probe that gives a value for every token, e.g. a linear probe."""

    name: str
    """Name of the probe, unique among the probes."""

    description: str | None = None
    """What the probe detects."""

    layer: int | None = None
    """Layer of the model whose activations the probe reads, if any."""

    @model_validator(mode="after")
    def _check_name(self) -> "TokenProbe":
        if not self.name:
            raise ValueError("A probe has an empty name")
        return self


class TokenValuesPart(BaseModel):
    """The tokens of the text of one message, and each probe's value on each."""

    message_id: str
    """`ChatMessage.id` of the message."""

    content_index: int | None
    """Index of the part in the message's content list, or None if the
    message's content is a string."""

    starts: list[int]
    """Code-point offset into the text where each token starts (inclusive)."""

    ends: list[int]
    """Code-point offset into the text where each token ends (exclusive)."""

    values: dict[str, list[float]]
    """Probe name to its value on each token."""

    @model_validator(mode="after")
    def _check_tokens(self) -> "TokenValuesPart":
        where = describe_part(self.message_id, self.content_index)
        if self.content_index is not None and self.content_index < 0:
            raise ValueError(f"The {where} has a negative content index")
        if len(self.starts) != len(self.ends):
            raise ValueError(
                f"The {where} has {len(self.starts)} starts but {len(self.ends)} ends"
            )
        previous_end = 0
        for index, (start, end) in enumerate(zip(self.starts, self.ends, strict=True)):
            token = f"Token {index} [{start}, {end}) of the {where}"
            if start < 0:
                raise ValueError(f"{token} starts before 0")
            if start < previous_end:
                raise ValueError(
                    f"{token} overlaps or comes before the token before it"
                )
            if end <= start:
                raise ValueError(f"{token} is empty")
            previous_end = end
        for name, values in self.values.items():
            if len(values) != len(self.starts):
                raise ValueError(
                    f"Probe '{name}' has {len(values)} values for the "
                    f"{len(self.starts)} tokens of the {where}"
                )
            for index, value in enumerate(values):
                if not math.isfinite(value):
                    raise ValueError(
                        f"Value {index} of probe '{name}' in the {where} isn't "
                        f"finite: {value}"
                    )
        return self


class TokenValues(BaseModel):
    """The per-token values of one sample, and the probes that gave them."""

    version: Literal[0] = 0
    """Version of this format."""

    unit: Literal["token"] = "token"
    """What a value is given for."""

    tokenizer: str
    """Tokenizer that split the text, e.g. "tiktoken/o200k_base"."""

    probes: list[TokenProbe]
    """Probes that gave the values."""

    parts: list[TokenValuesPart]
    """Parts with values, in transcript order (message order, then content index)."""

    @model_validator(mode="after")
    def _check_parts(self) -> "TokenValues":
        names = [probe.name for probe in self.probes]
        if not names:
            raise ValueError("TokenValues needs at least one probe")
        if len(set(names)) != len(names):
            raise ValueError(f"Probe names are repeated: {names}")
        seen: set[tuple[str, int | None]] = set()
        for part in self.parts:
            where = describe_part(part.message_id, part.content_index)
            if set(part.values) != set(names):
                raise ValueError(
                    f"Probes of the {where} are {sorted(part.values)}, not {names}"
                )
            key = (part.message_id, part.content_index)
            if key in seen:
                raise ValueError(f"The {where} appears more than once")
            seen.add(key)
        return self


def describe_part(message_id: str, content_index: int | None) -> str:
    """Name a part in error messages, e.g. "part 2 of message abc"."""
    if content_index is None:
        return f"string content of message {message_id}"
    return f"part {content_index} of message {message_id}"


class TextPart(NamedTuple):
    """The text of one content part of a message, or of its string content."""

    message_id: str
    content_index: int | None
    """None if the message's content is a string."""
    text: str


def text_parts(messages: Sequence[ChatMessage]) -> list[TextPart]:
    """The non-empty texts of every message, in transcript order.

    Reads messages of every role. A message whose content is a string gives
    one part with `content_index` None. Otherwise each text part and each
    reasoning part that isn't redacted gives a part; other content (images,
    tool use and so on) and assistant tool calls give none. Empty texts are
    skipped, since they have no tokens.

    Raises:
        ValueError: If a message with a text part has no id or the same id
            as an earlier one.
    """
    parts: list[TextPart] = []
    seen_ids: set[str] = set()
    for message in messages:
        found: list[tuple[int | None, str]] = []
        if isinstance(message.content, str):
            found.append((None, message.content))
        else:
            for content_index, part in enumerate(message.content):
                text = part_text(part, TEXT_CONTENT)
                if text is not None:
                    found.append((content_index, text))
        found = [(content_index, text) for content_index, text in found if text]
        if not found:
            continue
        if message.id is None:
            raise ValueError(f"A {message.role} message with text has no id")
        if message.id in seen_ids:
            raise ValueError(f"Two messages with text have the same id: {message.id}")
        seen_ids.add(message.id)
        parts += [TextPart(message.id, index, text) for index, text in found]
    return parts


def part_offsets(part: TokenValuesPart) -> list[TextRange]:
    """The code-point range of each token of a part."""
    return [
        TextRange(start, end) for start, end in zip(part.starts, part.ends, strict=True)
    ]


def check_part_offsets(part: TokenValuesPart, text: str) -> None:
    """Check that a part's tokens lie within its text.

    `TokenValuesPart` already checks that the tokens are ascending, so only
    the last one needs checking.

    Raises:
        ValueError: If the last token ends past the end of the text.
    """
    if part.ends and part.ends[-1] > len(text):
        where = describe_part(part.message_id, part.content_index)
        raise ValueError(
            f"The last token of the {where} ends at {part.ends[-1]}, past the "
            f"end of its text ({len(text)})"
        )


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


def token_offsets(text: str, encoding_name: str = "o200k_base") -> list[TextRange]:
    """Where each token of `text` lies in it, using a tiktoken encoding.

    tiktoken gives each token the offset of the character its first byte
    belongs to, so when one character is split over several tokens, those
    tokens share a start. They are merged into one token, so that no token
    is empty. Special-token text such as "<|endoftext|>" is encoded as
    ordinary text.

    Args:
        text: Text to tokenise.
        encoding_name: Name of the tiktoken encoding.

    Raises:
        ValueError: If the tokens don't decode to `text` (e.g. it has lone
            surrogates) or don't cover it exactly.
    """
    encoding = tiktoken.get_encoding(encoding_name)
    decoded, starts = encoding.decode_with_offsets(
        encoding.encode(text, disallowed_special=())
    )
    if decoded != text:
        raise ValueError(
            f"Tokens of a text of length {len(text)} decode to a different text"
        )
    bounds = [*dict.fromkeys(starts), len(text)]
    offsets = [TextRange(start, end) for start, end in pairwise(bounds)]
    check_covers(text, offsets)
    return offsets
