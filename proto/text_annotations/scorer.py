"""A scorer that stores the values of some fields on spans of a sample's text.

`text_annotations` adds one layer of `TextAnnotations` to its score's
metadata. An `Annotator` gives the layer's spans and their values. Write one
to attach values computed elsewhere, or build one from a `SpanFinder` and a
classifier (`classifiers.classifier_annotator`) or a probe runner
(`probes.probe_annotator`).
"""

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Protocol, TypeVar

from pydantic import JsonValue

from inspect_ai.model import ChatMessage
from inspect_ai.scorer import Metric, Score, Scorer, Target, mean, scorer, stderr
from inspect_ai.solver import TaskState

from .annotations import (
    TEXT_ANNOTATIONS_KEY,
    AnnotatedPart,
    AnnotationLayer,
    CategoricalField,
    NumericField,
    TextAnnotations,
    check_spans_fit,
    describe_part,
    text_parts,
)
from .spans import Span

ANNOTATION_METRICS: list[Metric] = [mean(), stderr()]
"""Mean number of spans per sample, and its standard error."""

FieldType = TypeVar("FieldType", CategoricalField, NumericField)


@dataclass(frozen=True)
class AnnotatedSpan:
    """A span and the value of each field of a layer on it."""

    span: Span
    values: Mapping[str, str | float]
    """Field name to its value: one of a categorical field's options, or a
    finite number for a numeric field."""
    probabilities: Mapping[str, Mapping[str, float]] = field(default_factory=dict)
    """Categorical field name to the probability of each of its options.

    Optional for each field, but the spans of one message part must all have
    them or all not."""


class Annotator(Protocol):
    """Gives the spans of a sample's text and the value of every field on each."""

    async def __call__(
        self, state: TaskState, fields: Sequence[CategoricalField | NumericField]
    ) -> list[AnnotatedSpan]:
        """Annotate one sample.

        Args:
            state: State of the sample.
            fields: Fields to give a value on every span.

        Returns:
            The spans, in any order, each in one of the messages' `text_parts`.
        """
        ...


@scorer(metrics=ANNOTATION_METRICS)
def text_annotations(
    layer_name: str,
    fields: Sequence[CategoricalField | NumericField],
    annotate: Annotator,
    *,
    source: str,
    unit: str,
    description: str | None = None,
    metadata: Mapping[str, JsonValue] | None = None,
) -> Scorer:
    """Store the value of some fields on spans of the sample's messages.

    Adds a layer with the spans and values that `annotate` gives. They are
    grouped into parts, in transcript order, and checked against the fields
    and the messages. The score's value is the number of spans.

    To give the score another name, wrap this in a `@scorer`-decorated
    factory with `metrics=ANNOTATION_METRICS` (the score takes the factory's
    name).

    Args:
        layer_name: Name of the layer, e.g. "paragraph labels".
        fields: Fields to give a value on every span.
        annotate: Gives the spans and the values.
        source: What produced the values, e.g. "typesafe/jev-1.14".
        unit: What one span is, for display, e.g. "paragraph" or "token".
        description: What the layer holds.
        metadata: How the layer was made, e.g.
            `{"tokenizer": "tiktoken/o200k_base"}`.

    Raises:
        ValidationError: If the fields or the layer's other attributes are
            invalid.
    """
    fields = list(fields)
    layer_metadata = dict(metadata or {})

    def make_layer(parts: list[AnnotatedPart]) -> AnnotationLayer:
        return AnnotationLayer(
            name=layer_name,
            unit=unit,
            source=source,
            metadata=layer_metadata,
            description=description,
            fields=fields,
            parts=parts,
        )

    # validates the fields now rather than at the first sample
    make_layer([])

    async def score(state: TaskState, target: Target) -> Score:
        sample = describe_sample(state)
        spans = await annotate(state, fields)
        parts = annotated_parts(spans, fields, state.messages, sample)
        return annotation_score([layer_for_sample(make_layer, parts, sample)])

    return score


def annotated_parts(
    spans: Sequence[AnnotatedSpan],
    fields: Sequence[CategoricalField | NumericField],
    messages: Sequence[ChatMessage],
    sample: str,
) -> list[AnnotatedPart]:
    """Group spans into parts, in transcript order, each with its spans in order.

    Args:
        spans: Spans of one sample, in any order.
        fields: Fields that every span has a value of.
        messages: Messages of the sample.
        sample: Name of the sample in error messages.

    Raises:
        ValueError: If a span isn't in one of the messages' `text_parts`, or a
            part's spans don't make a valid part within its text. The message
            names the sample and the part.
    """
    positions = {
        (part.message_id, part.content_index): (position, part.text)
        for position, part in enumerate(text_parts(messages))
    }
    by_part: dict[tuple[str, int | None], list[AnnotatedSpan]] = {}
    for annotated in spans:
        key = (annotated.span.message_id, annotated.span.content_index)
        if key not in positions:
            raise ValueError(
                f"Spans of {sample} are in the {describe_part(*key)}, which isn't "
                "a text part of its messages"
            )
        by_part.setdefault(key, []).append(annotated)
    parts: list[AnnotatedPart] = []
    for key in sorted(by_part, key=lambda key: positions[key][0]):
        in_order = sorted(by_part[key], key=lambda a: (a.span.start, a.span.end))
        try:
            part = annotated_part(in_order, fields)
            check_spans_fit(part, positions[key][1])
        except ValueError as ex:
            raise ValueError(
                f"Invalid annotations for the {describe_part(*key)} of {sample}: {ex}"
            ) from ex
        parts.append(part)
    return parts


def annotated_part(
    spans: Sequence[AnnotatedSpan], fields: Sequence[CategoricalField | NumericField]
) -> AnnotatedPart:
    """The part holding the spans of one message part.

    Args:
        spans: Spans of one message part, in order (at least one).
        fields: Fields that every span has a value of.

    Raises:
        ValueError: If a span doesn't have a value of exactly the fields, the
            probabilities aren't of a categorical field, don't cover its
            options or are given for only some spans, or the spans don't make
            a valid part.
    """
    names = [field.name for field in fields]
    for annotated in spans:
        if set(annotated.values) != set(names):
            raise ValueError(
                f"Span {describe_range(annotated.span)} has values of "
                f"{sorted(annotated.values)}, not {names}"
            )
    with_probabilities = {name for a in spans for name in a.probabilities}
    categorical = [f for f in fields if isinstance(f, CategoricalField)]
    unknown = with_probabilities - {f.name for f in categorical}
    if unknown:
        raise ValueError(
            f"Spans have probabilities of {sorted(unknown)}, which aren't "
            "categorical fields"
        )
    probabilities: dict[str, list[list[float]]] = {}
    for question in categorical:
        if question.name not in with_probabilities:
            continue
        rows: list[list[float]] = []
        for annotated in spans:
            span = describe_range(annotated.span)
            options = annotated.probabilities.get(question.name)
            if options is None:
                raise ValueError(
                    f"Span {span} has no probabilities of '{question.name}', but "
                    "other spans do"
                )
            if set(options) != set(question.options):
                raise ValueError(
                    f"Probabilities of '{question.name}' for span {span} cover "
                    f"{sorted(options)}, not its options {question.options}"
                )
            rows.append([options[option] for option in question.options])
        probabilities[question.name] = rows
    first = spans[0].span
    # each field's values are `str | float` here; validation, not the
    # constructor's types, decides whether they are a `list[str]` or `list[float]`
    return AnnotatedPart.model_validate(
        {
            "message_id": first.message_id,
            "content_index": first.content_index,
            "starts": [annotated.span.start for annotated in spans],
            "ends": [annotated.span.end for annotated in spans],
            "values": {name: [a.values[name] for a in spans] for name in names},
            "probabilities": probabilities,
        }
    )


def describe_range(span: Span) -> str:
    """E.g. "[3, 7)"."""
    return f"[{span.start}, {span.end})"


def layer_for_sample(
    make_layer: Callable[[list[AnnotatedPart]], AnnotationLayer],
    parts: list[AnnotatedPart],
    sample: str,
) -> AnnotationLayer:
    """A layer from the parts of one sample, naming the sample if they're invalid.

    Raises:
        ValueError: If the parts don't make a valid layer.
    """
    try:
        return make_layer(parts)
    except ValueError as ex:
        raise ValueError(f"Invalid annotations for {sample}: {ex}") from ex


def annotation_score(layers: Sequence[AnnotationLayer]) -> Score:
    """A score holding annotation layers in its metadata.

    Its value is the total number of spans in the layers, and its explanation
    gives each layer's number of spans and fields, e.g. "71 paragraphs, 4
    fields".

    Raises:
        ValueError: If the layers don't make valid `TextAnnotations`.
    """
    annotations = TextAnnotations(layers=list(layers))
    explanation = "; ".join(
        f"{plural(layer.span_count(), layer.unit)}, {plural(len(layer.fields), 'field')}"
        for layer in annotations.layers
    )
    return Score(
        value=sum(layer.span_count() for layer in annotations.layers),
        explanation=explanation,
        metadata={TEXT_ANNOTATIONS_KEY: annotations.model_dump()},
    )


def describe_sample(state: TaskState) -> str:
    """Name a sample in error messages, e.g. "sample 3 (epoch 1)"."""
    return f"sample {state.sample_id} (epoch {state.epoch})"


def plural(count: int, noun: str) -> str:
    """E.g. "1 token" or "3 tokens"."""
    return f"{count} {noun}" if count == 1 else f"{count} {noun}s"


def fields_of_type(
    fields: Sequence[CategoricalField | NumericField],
    field_type: type[FieldType],
    annotator: str,
) -> list[FieldType]:
    """The fields, after checking that all are of one type.

    Args:
        fields: Fields an annotator is asked to give values of.
        field_type: Type of field the annotator gives values of.
        annotator: Name of the annotator in error messages, e.g. "A classifier".

    Raises:
        ValueError: If a field isn't of `field_type`.
    """
    found = [field for field in fields if isinstance(field, field_type)]
    if len(found) != len(fields):
        others = [field.name for field in fields if not isinstance(field, field_type)]
        raise ValueError(
            f"{annotator} can't give values of {others}, which aren't "
            f"{field_type.__name__}s"
        )
    return found
