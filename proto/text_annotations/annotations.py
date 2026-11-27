"""Annotations of transcript text: the stored format and the text parts it points at.

Annotations are stored in a score's metadata under `text_annotations`, as
`TextAnnotations(...).model_dump()`. They hold one or more annotation sets.
An annotation set gives the value of one or more fields on each of its spans,
which can be any non-overlapping ranges of the text. A field is categorical
(one of a list of options, e.g. a classifier's answer to a question, optionally
with the probability of each option) or numeric (e.g. a probe's value). A
categorical field's `negative` options are those that mean nothing was found,
e.g. "no". Fields and annotation sets have a `metadata` dict for anything else
about how they were made.

An annotation set's spans are grouped into parts, one per text part of a
message: `message_id` and `content_index` find the text, and `starts` and
`ends` are Unicode code-point offsets (Python `str` indices) into it. The text is
`ContentText.text` for text parts, `ContentReasoning.reasoning` for reasoning
parts that aren't redacted, and the message's `content` when that is a string
(then `content_index` is None). See `text_parts`.
"""

import math
from collections.abc import Collection, Sequence
from typing import Annotated, Literal, NamedTuple, get_args

from pydantic import BaseModel, ConfigDict, Field, JsonValue, model_validator

from inspect_ai.model import ChatMessage, ContentReasoning, ContentText

TEXT_ANNOTATIONS_KEY = "text_annotations"
"""Key of the `TextAnnotations` in a score's metadata."""

PROBABILITY_TOLERANCE = 0.01
"""How far from 1 a span's probabilities for a field may sum."""

ContentType = Literal["reasoning", "text"]
"""Kinds of text part: reasoning, or text (including a message's string content)."""

Role = Literal["system", "user", "assistant", "tool"]
"""Role of a message."""


class _FormatModel(BaseModel):
    """Base of the format's models: unknown keys and type coercion are errors."""

    model_config = ConfigDict(extra="forbid", strict=True)


class CategoricalField(_FormatModel):
    """A field whose value is one of a list of options, e.g. a classifier's answer."""

    name: str = Field(min_length=1)
    """Name of the field, unique within its annotation set."""

    description: str | None = None
    """What the field holds, e.g. the question a classifier answers."""

    type: Literal["categorical"] = "categorical"

    options: list[str]
    """Possible values (at least two, all different)."""

    negative: list[str] = Field(default_factory=list)
    """Options that mean nothing was found, e.g. "no" for a yes/no question.

    Some of the options, all different, but not all of them. A viewer can
    leave spans with these values untinted, to show only what was found."""

    metadata: dict[str, JsonValue] = Field(default_factory=dict)
    """Anything else about the field, e.g. how its values were made."""

    @model_validator(mode="after")
    def _check_options(self) -> "CategoricalField":
        if len(self.options) < 2:
            raise ValueError(
                f"Field '{self.name}' needs at least two options, got {self.options}"
            )
        if len(set(self.options)) != len(self.options):
            raise ValueError(
                f"Field '{self.name}' has repeated options: {self.options}"
            )
        unknown = [option for option in self.negative if option not in self.options]
        if unknown:
            raise ValueError(
                f"Negative options {unknown} of field '{self.name}' aren't among "
                f"its options {self.options}"
            )
        if len(set(self.negative)) != len(self.negative):
            raise ValueError(
                f"Field '{self.name}' has repeated negative options: {self.negative}"
            )
        if len(self.negative) == len(self.options):
            raise ValueError(
                f"Every option of field '{self.name}' is negative: {self.negative}"
            )
        return self


class NumericField(_FormatModel):
    """A field whose value is a number, e.g. a probe's value."""

    name: str = Field(min_length=1)
    """Name of the field, unique within its annotation set."""

    description: str | None = None
    """What the field holds, e.g. what a probe detects."""

    type: Literal["numeric"] = "numeric"

    metadata: dict[str, JsonValue] = Field(default_factory=dict)
    """Anything else about the field, e.g. `{"model_layer": 24}` for a probe."""


AnnotationField = Annotated[
    CategoricalField | NumericField, Field(discriminator="type")
]
"""A field of an annotation set, told apart by its `type`."""


class TextRange(NamedTuple):
    """A [start, end) range of code points in a string."""

    start: int
    end: int


class AnnotatedPart(_FormatModel):
    """The spans of the text of one message part, and each field's value on each."""

    message_id: str
    """`ChatMessage.id` of the message."""

    content_index: int | None
    """Index of the part in the message's content list, or None if the
    message's content is a string."""

    starts: list[int]
    """Code-point offset into the text where each span starts (inclusive)."""

    ends: list[int]
    """Code-point offset into the text where each span ends (exclusive)."""

    values: dict[str, list[str] | list[float]]
    """Field name to its value on each span: an option of a categorical field,
    or a finite number for a numeric field."""

    probabilities: dict[str, list[list[float]]] = Field(default_factory=dict)
    """Categorical field name to, for each span, the probability of each of
    its options (in the field's order). Optional for each field."""

    @model_validator(mode="after")
    def _check_spans(self) -> "AnnotatedPart":
        where = describe_part(self.message_id, self.content_index)
        if self.content_index is not None and self.content_index < 0:
            raise ValueError(f"The {where} has a negative content index")
        if len(self.starts) != len(self.ends):
            raise ValueError(
                f"The {where} has {len(self.starts)} starts but {len(self.ends)} ends"
            )
        previous_end = 0
        for index, (start, end) in enumerate(zip(self.starts, self.ends, strict=True)):
            span = f"Span {index} [{start}, {end}) of the {where}"
            if start < 0:
                raise ValueError(f"{span} starts before 0")
            if start < previous_end:
                raise ValueError(f"{span} overlaps or comes before the span before it")
            if end <= start:
                raise ValueError(f"{span} is empty")
            previous_end = end
        spans = len(self.starts)
        for name, values in self.values.items():
            if len(values) != spans:
                raise ValueError(
                    f"Field '{name}' has {len(values)} values for the {spans} spans "
                    f"of the {where}"
                )
            for index, value in enumerate(values):
                if isinstance(value, float) and not math.isfinite(value):
                    raise ValueError(
                        f"Value {index} of field '{name}' in the {where} isn't "
                        f"finite: {value}"
                    )
        for name, rows in self.probabilities.items():
            if len(rows) != spans:
                raise ValueError(
                    f"Field '{name}' has {len(rows)} probability lists for the "
                    f"{spans} spans of the {where}"
                )
            for index, row in enumerate(rows):
                if not all(0.0 <= p <= 1.0 for p in row) or (
                    abs(math.fsum(row) - 1.0) > PROBABILITY_TOLERANCE + 1e-9
                ):
                    raise ValueError(
                        f"Probabilities of field '{name}' for span {index} of the "
                        f"{where} aren't all in [0, 1] or don't sum to 1: {row}"
                    )
        return self

    def ranges(self) -> list[TextRange]:
        """The code-point range of each span."""
        return [
            TextRange(start, end)
            for start, end in zip(self.starts, self.ends, strict=True)
        ]


class AnnotationSet(_FormatModel):
    """Values of some fields on every span of an annotation set."""

    name: str = Field(min_length=1)
    """Name of the set, unique within its score, e.g. "paragraph labels"."""

    unit: Annotated[str, Field(min_length=1)] | None = None
    """What one span is, for display only, e.g. "paragraph" or "token".

    None if not given; a viewer then calls each one a "span"."""

    source: str
    """What produced the values, e.g. a classifier's or probe runner's name."""

    metadata: dict[str, JsonValue] = Field(default_factory=dict)
    """How the set was made, e.g. `{"tokenizer": "tiktoken/o200k_base"}`."""

    description: str | None = None
    """What the set holds."""

    fields: list[AnnotationField]
    """Fields with a value on every span (at least one, names all different)."""

    parts: list[AnnotatedPart]
    """Parts with spans, in transcript order, at most one per message part."""

    @model_validator(mode="after")
    def _check_parts(self) -> "AnnotationSet":
        names = [field.name for field in self.fields]
        if not names:
            raise ValueError(f"Annotation set '{self.name}' needs at least one field")
        if len(set(names)) != len(names):
            raise ValueError(
                f"Field names of annotation set '{self.name}' are repeated: {names}"
            )
        categorical = {
            field.name: field
            for field in self.fields
            if isinstance(field, CategoricalField)
        }
        seen: set[tuple[str, int | None]] = set()
        for part in self.parts:
            where = describe_part(part.message_id, part.content_index)
            if set(part.values) != set(names):
                raise ValueError(
                    f"Fields of the {where} are {sorted(part.values)}, not {names}"
                )
            for field in self.fields:
                check_values(field, part.values[field.name], where)
            for name, rows in part.probabilities.items():
                if name not in categorical:
                    raise ValueError(
                        f"The {where} has probabilities for '{name}', which isn't "
                        "a categorical field"
                    )
                options = categorical[name].options
                if any(len(row) != len(options) for row in rows):
                    raise ValueError(
                        f"Probabilities of field '{name}' in the {where} don't give "
                        f"one for each of its {len(options)} options"
                    )
            key = (part.message_id, part.content_index)
            if key in seen:
                raise ValueError(f"The {where} appears more than once")
            seen.add(key)
        return self

    def span_count(self) -> int:
        """The number of spans in all parts."""
        return sum(len(part.starts) for part in self.parts)


class TextAnnotations(_FormatModel):
    """The annotation sets of one score."""

    version: Literal[2] = 2
    """Version of this format."""

    sets: list[AnnotationSet]
    """Annotation sets, with names all different."""

    @model_validator(mode="after")
    def _check_sets(self) -> "TextAnnotations":
        names = [annotation_set.name for annotation_set in self.sets]
        if len(set(names)) != len(names):
            raise ValueError(f"Annotation set names are repeated: {names}")
        return self


def check_values(
    field: CategoricalField | NumericField,
    values: list[str] | list[float],
    where: str,
) -> None:
    """Check that values are options of a categorical field or numbers for a numeric one.

    Raises:
        ValueError: If a value of a categorical field isn't one of its options,
            or a value of a numeric field isn't a number.
    """
    if isinstance(field, CategoricalField):
        options = set(field.options)
        for index, value in enumerate(values):
            if value not in options:
                raise ValueError(
                    f"Value {index} of field '{field.name}' in the {where} isn't "
                    f"one of its options {field.options}: {value!r}"
                )
    elif not all(isinstance(value, float) for value in values):
        raise ValueError(
            f"Values of numeric field '{field.name}' in the {where} aren't numbers"
        )


def describe_part(message_id: str, content_index: int | None) -> str:
    """Name a part in error messages, e.g. "part 2 of message abc"."""
    if content_index is None:
        return f"string content of message {message_id}"
    return f"part {content_index} of message {message_id}"


class TextPart(NamedTuple):
    """The text of one content part of a message, or of its string content."""

    message_id: str
    role: Role
    content_index: int | None
    """None if the message's content is a string."""
    content_type: ContentType
    """"text" for a message's string content."""
    text: str


def text_parts(
    messages: Sequence[ChatMessage],
    roles: Collection[Role] | None = None,
    content: Collection[ContentType] = ("reasoning", "text"),
) -> list[TextPart]:
    """The non-empty texts of the messages, in transcript order.

    A message whose content is a string gives one part with `content_index`
    None. Otherwise each text part and each reasoning part that isn't redacted
    (its text is encrypted) gives a part; other content (images, tool use and
    so on) and assistant tool calls give none. Empty texts are skipped, since
    they have no spans.

    Args:
        messages: Messages of the transcript.
        roles: Roles of the messages to read, or None for every role.
        content: Kinds of part to read (every kind by default).

    Raises:
        TypeError: If `roles` or `content` is a string rather than a
            collection of them.
        ValueError: If `roles` or `content` names an unknown role or kind of
            part, or a message with text (of any role) has no id or the same
            id as an earlier one.
    """
    check_selection(roles, content)
    parts: list[TextPart] = []
    seen_ids: set[str] = set()
    for message in messages:
        found: list[tuple[int | None, ContentType, str]] = []
        if isinstance(message.content, str):
            found.append((None, "text", message.content))
        else:
            for content_index, part in enumerate(message.content):
                if isinstance(part, ContentReasoning) and not part.redacted:
                    found.append((content_index, "reasoning", part.reasoning))
                elif isinstance(part, ContentText):
                    found.append((content_index, "text", part.text))
        found = [(index, kind, text) for index, kind, text in found if text]
        if not found:
            continue
        if message.id is None:
            raise ValueError(f"A {message.role} message with text has no id")
        if message.id in seen_ids:
            raise ValueError(f"Two messages with text have the same id: {message.id}")
        seen_ids.add(message.id)
        if roles is None or message.role in roles:
            parts += [
                TextPart(message.id, message.role, index, kind, text)
                for index, kind, text in found
                if kind in content
            ]
    return parts


def check_selection(roles: Collection[str] | None, content: Collection[str]) -> None:
    """Check that roles and kinds of part are known ones.

    Raises:
        TypeError: If `roles` or `content` is a string rather than a
            collection of them.
        ValueError: If a role isn't a `Role` or a kind of part isn't a
            `ContentType`.
    """
    for name, selected, known in (
        ("roles", roles, get_args(Role)),
        ("content types", content, get_args(ContentType)),
    ):
        if selected is None:
            continue
        if isinstance(selected, str):
            raise TypeError(f"Give {name} as a list, not the string {selected!r}")
        unknown = set(selected) - set(known)
        if unknown:
            raise ValueError(
                f"Unknown {name}: {sorted(unknown)} (expected some of {list(known)})"
            )


def check_spans_fit(part: AnnotatedPart, text: str) -> None:
    """Check that a part's spans lie within its text.

    `AnnotatedPart` already checks that the spans are ascending, so only the
    last one needs checking.

    Raises:
        ValueError: If the last span ends past the end of the text.
    """
    if part.ends and part.ends[-1] > len(text):
        where = describe_part(part.message_id, part.content_index)
        raise ValueError(
            f"The last span of the {where} ends at {part.ends[-1]}, past the end "
            f"of its text ({len(text)})"
        )


def set_texts(
    annotation_set: AnnotationSet, messages: Sequence[ChatMessage]
) -> list[str]:
    """The text of each part of an annotation set, checked against the messages.

    Checks what `AnnotationSet` can't check without the messages: each part
    is one of the messages' `text_parts`, the parts are in transcript order,
    and each part's spans lie within its text.

    Raises:
        ValueError: If a part isn't a text part of the messages, comes before
            the part before it, or has a span past the end of its text.
    """
    positions = {
        (part.message_id, part.content_index): (position, part.text)
        for position, part in enumerate(text_parts(messages))
    }
    texts: list[str] = []
    previous = -1
    for part in annotation_set.parts:
        where = describe_part(part.message_id, part.content_index)
        found = positions.get((part.message_id, part.content_index))
        if found is None:
            raise ValueError(
                f"Annotation set '{annotation_set.name}' has spans for the {where}, "
                "which isn't a text part of the messages"
            )
        position, text = found
        if position <= previous:
            raise ValueError(
                f"The {where} comes before the part before it in annotation set "
                f"'{annotation_set.name}'"
            )
        previous = position
        check_spans_fit(part, text)
        texts.append(text)
    return texts
