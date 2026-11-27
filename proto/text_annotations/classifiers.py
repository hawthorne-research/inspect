"""Helpers for labelling spans with a classifier's answers to questions about them.

A question is a `CategoricalField`; `binary_question` makes a yes/no one.
`classifier_annotator` gives each span the most probable answer to each
question, with the probabilities, from any `Classifier` and `SpanFinder`.
"""

from collections.abc import Sequence
from typing import Protocol

from inspect_ai.solver import TaskState

from .annotations import CategoricalField, NumericField, describe_part
from .scorer import (
    AnnotatedSpan,
    Annotator,
    describe_range,
    describe_sample,
    fields_of_type,
)
from .spans import SpanFinder, span_texts

SpanProbabilities = dict[str, dict[str, float]]
"""Question name to the probability of each of its options, for one span."""


def binary_question(
    name: str,
    description: str | None = None,
    positive: str = "yes",
    negative: str = "no",
) -> CategoricalField:
    """A yes/no question: options `[positive, negative]`, with `negative=[negative]`.

    Args:
        name: Name of the field.
        description: The question, e.g. "Does the agent suspect it is being
            tested?".
        positive: The answer meaning the thing was found, e.g. "yes" or "1".
        negative: The answer meaning it wasn't, e.g. "no" or "0".

    Raises:
        ValidationError: If `name` is empty or the two answers are the same.
    """
    return CategoricalField(
        name=name,
        description=description,
        options=[positive, negative],
        negative=[negative],
    )


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


def classifier_annotator(find_spans: SpanFinder, classify: Classifier) -> Annotator:
    """Label every span with a classifier's answers to questions about it.

    The fields are the questions, so all must be categorical. Each span is
    labelled with the most probable option of each question (the earliest
    option on ties), and the probabilities are kept. The classifier isn't
    called for a sample without spans.

    Args:
        find_spans: Gives the spans of a sample's messages, e.g.
            `find_spans(paragraphs, roles=["assistant"])`.
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
