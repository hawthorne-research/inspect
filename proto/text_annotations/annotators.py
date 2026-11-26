"""Annotators that apply a classifier or a probe runner to spans.

`classifier_annotator` gives categorical values: each span's most probable
answer to each question, with the probabilities. `probe_annotator` gives
numeric values: each probe's value on each span. Both take a `SpanFinder`,
e.g. `paragraph_spans` or `token_spans`, and work with any.
"""

from collections.abc import Sequence
from typing import Protocol, TypeVar

from inspect_ai.solver import TaskState

from .annotations import CategoricalField, NumericField, describe_part
from .scorer import AnnotatedSpan, Annotator, describe_range, describe_sample
from .spans import Span, SpanFinder, span_texts

DECIMALS = 3
"""Decimals that `probe_annotator` rounds values to by default."""

SpanProbabilities = dict[str, dict[str, float]]
"""Question name to the probability of each of its options, for one span."""

FieldType = TypeVar("FieldType", CategoricalField, NumericField)


class Classifier(Protocol):
    """Gives the probability of each answer to each question, for each text."""

    async def __call__(
        self, texts: list[str], questions: Sequence[CategoricalField], state: TaskState
    ) -> list[SpanProbabilities]:
        """Classify the spans of one sample.

        Args:
            texts: Text of each span, in transcript order.
            questions: Questions to answer about every span.
            state: State of the sample the spans come from.

        Returns:
            One `SpanProbabilities` per text, in the same order.
        """
        ...


class ProbeRunner(Protocol):
    """Gives each probe's value on each span."""

    async def __call__(
        self, spans: list[Span], probes: Sequence[NumericField], state: TaskState
    ) -> dict[str, list[float]]:
        """Run the probes over the spans of one sample.

        Args:
            spans: Spans of the sample, in transcript order.
            probes: Probes to run.
            state: State of the sample the spans come from.

        Returns:
            Probe name to its value on each span, in the same order.
        """
        ...


def classifier_annotator(find_spans: SpanFinder, classify: Classifier) -> Annotator:
    """Label every span with a classifier's answers to questions about it.

    The fields are the questions, so all must be categorical. Each span is
    labelled with the most probable option of each question (the earliest
    option on ties), and the probabilities are kept. The classifier isn't
    called for a sample without spans.

    Args:
        find_spans: Gives the spans of a sample's messages.
        classify: Gives the probabilities of the answers.
    """

    async def annotate(
        state: TaskState, fields: Sequence[CategoricalField | NumericField]
    ) -> list[AnnotatedSpan]:
        sample = describe_sample(state)
        questions = fields_of_type(fields, CategoricalField, "A classifier")
        spans = find_spans(state.messages)
        texts = span_texts(spans, state.messages)
        probabilities = await classify(texts, questions, state) if texts else []
        if len(probabilities) != len(spans):
            raise ValueError(
                f"The classifier gave {len(probabilities)} results for "
                f"{len(spans)} spans of {sample}"
            )
        annotated: list[AnnotatedSpan] = []
        for span, span_probabilities in zip(spans, probabilities, strict=True):
            try:
                labels = most_probable(span_probabilities, questions)
            except ValueError as ex:
                where = describe_part(span.message_id, span.content_index)
                raise ValueError(
                    f"Invalid probabilities for span {describe_range(span)} of the "
                    f"{where} of {sample}: {ex}"
                ) from ex
            annotated.append(AnnotatedSpan(span, labels, span_probabilities))
        return annotated

    return annotate


def most_probable(
    probabilities: SpanProbabilities, questions: Sequence[CategoricalField]
) -> dict[str, str]:
    """The most probable option of each question (the earliest one on ties).

    Raises:
        ValueError: If the probabilities don't cover exactly the questions and
            their options.
    """
    names = [question.name for question in questions]
    if set(probabilities) != set(names):
        raise ValueError(
            f"Probabilities cover questions {sorted(probabilities)}, not {names}"
        )
    labels: dict[str, str] = {}
    for question in questions:
        option_probabilities = probabilities[question.name]
        if set(option_probabilities) != set(question.options):
            raise ValueError(
                f"Probabilities for '{question.name}' cover "
                f"{sorted(option_probabilities)}, not its options {question.options}"
            )
        labels[question.name] = max(
            question.options, key=option_probabilities.__getitem__
        )
    return labels


def probe_annotator(
    find_spans: SpanFinder, run_probes: ProbeRunner, decimals: int = DECIMALS
) -> Annotator:
    """Give every span each probe's value.

    The fields are the probes, so all must be numeric. Values are rounded to
    `decimals` decimals, which keeps logs small when there are many spans.
    The probe runner isn't called for a sample without spans.

    Args:
        find_spans: Gives the spans of a sample's messages.
        run_probes: Gives each probe's value on each span.
        decimals: Decimals to round values to.
    """

    async def annotate(
        state: TaskState, fields: Sequence[CategoricalField | NumericField]
    ) -> list[AnnotatedSpan]:
        sample = describe_sample(state)
        probes = fields_of_type(fields, NumericField, "A probe runner")
        names = [probe.name for probe in probes]
        spans = find_spans(state.messages)
        values = await run_probes(spans, probes, state) if spans else {}
        if spans and set(values) != set(names):
            raise ValueError(
                f"The probe runner gave values of {sorted(values)} for {sample}, "
                f"not of {names}"
            )
        for name, probe_values in values.items():
            if len(probe_values) != len(spans):
                raise ValueError(
                    f"The probe runner gave {len(probe_values)} values of '{name}' "
                    f"for {len(spans)} spans of {sample}"
                )
        return [
            AnnotatedSpan(
                span, {name: round(values[name][index], decimals) for name in names}
            )
            for index, span in enumerate(spans)
        ]

    return annotate


def fields_of_type(
    fields: Sequence[CategoricalField | NumericField],
    field_type: type[FieldType],
    annotator: str,
) -> list[FieldType]:
    """The fields, after checking that all are of one type.

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
