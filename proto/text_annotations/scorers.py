"""Scorers that annotate a sample's transcript text: paragraph labels and token values.

Each scorer adds one layer of `TextAnnotations` to its score's metadata.
"""

from collections.abc import Callable, Sequence
from typing import NamedTuple, Protocol

from inspect_ai.scorer import Metric, Score, Scorer, Target, mean, scorer, stderr
from inspect_ai.solver import TaskState

from .annotations import (
    REASONING,
    TEXT_ANNOTATIONS_KEY,
    AnnotatedPart,
    AnnotationLayer,
    CategoricalField,
    ContentType,
    NumericField,
    TextAnnotations,
    TextPart,
    TextRange,
    check_spans_fit,
    describe_part,
    text_parts,
)
from .paragraphs import Paragraph, check_content_types, message_paragraphs

ANNOTATION_METRICS: list[Metric] = [mean(), stderr()]
"""Mean number of spans per sample, and its standard error."""

PARAGRAPH_LAYER = "paragraph labels"
"""Name of the layer `paragraph_labels` adds."""

TOKEN_LAYER = "probes"
"""Name of the layer `token_values` adds."""

DECIMALS = 3
"""Decimals that `token_values` rounds values to."""

SpanProbabilities = dict[str, dict[str, float]]
"""Question name to the probability of each of its options, for one span."""


class SpanClassifier(Protocol):
    """Gives the probability of each answer to each question, for each span."""

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


class PartValues(NamedTuple):
    """The tokens of one text part and each probe's value on each token."""

    offsets: list[TextRange]
    """Code-point range of each token in the part's text."""
    values: dict[str, list[float]]
    """Probe name to its value on each token."""


class ProbeRunner(Protocol):
    """Tokenises each text part and gives each probe's value on every token."""

    async def __call__(
        self, parts: list[TextPart], probes: Sequence[NumericField], state: TaskState
    ) -> list[PartValues]:
        """Run the probes over the text parts of one sample.

        Args:
            parts: Text parts of the sample, in transcript order.
            probes: Probes to run.
            state: State of the sample the parts come from.

        Returns:
            One `PartValues` per part, in the same order.
        """
        ...


@scorer(metrics=ANNOTATION_METRICS)
def paragraph_labels(
    questions: Sequence[CategoricalField],
    classify: SpanClassifier,
    classifier_name: str,
    content_types: Sequence[ContentType] = REASONING,
) -> Scorer:
    """Label every paragraph of the assistant messages with a classifier.

    Adds a layer with one categorical field per question. Each paragraph is
    labelled with the most probable option of each question (the earliest
    option on ties), and the probabilities are kept.

    To give the score another name, wrap this in a `@scorer`-decorated
    factory with `metrics=ANNOTATION_METRICS` (the score takes the factory's
    name).

    Args:
        questions: Questions to answer about every paragraph.
        classify: Classifier giving the probabilities of the answers.
        classifier_name: Name recorded as the layer's source, e.g.
            "typesafe/jev-1.14".
        content_types: Kinds of text part to split into paragraphs.
    """
    questions = list(questions)
    check_content_types(content_types)

    def make_layer(parts: list[AnnotatedPart]) -> AnnotationLayer:
        return AnnotationLayer(
            name=PARAGRAPH_LAYER,
            unit="paragraph",
            source=classifier_name,
            description="A classifier's answers to questions about each paragraph.",
            fields=[*questions],
            parts=parts,
        )

    # validates the questions now rather than at the first sample
    make_layer([])

    async def score(state: TaskState, target: Target) -> Score:
        sample = describe_sample(state)
        paragraphs = message_paragraphs(state.messages, content_types)
        texts = [paragraph.text for paragraph in paragraphs]
        probabilities = await classify(texts, questions, state) if texts else []
        if len(probabilities) != len(paragraphs):
            raise ValueError(
                f"Classifier {classifier_name} gave {len(probabilities)} results "
                f"for {len(paragraphs)} paragraphs of {sample}"
            )
        by_part: dict[tuple[str, int | None], list[int]] = {}
        for index, paragraph in enumerate(paragraphs):
            key = (paragraph.message_id, paragraph.content_index)
            by_part.setdefault(key, []).append(index)
        parts: list[AnnotatedPart] = []
        for (message_id, content_index), indices in by_part.items():
            try:
                parts.append(
                    labelled_part(
                        [paragraphs[index] for index in indices],
                        [probabilities[index] for index in indices],
                        questions,
                    )
                )
            except ValueError as ex:
                where = describe_part(message_id, content_index)
                raise ValueError(
                    f"Invalid labels for the {where} of {sample}: {ex}"
                ) from ex
        return annotation_score([layer_for_sample(make_layer, parts, sample)])

    return score


def labelled_part(
    paragraphs: list[Paragraph],
    probabilities: list[SpanProbabilities],
    questions: Sequence[CategoricalField],
) -> AnnotatedPart:
    """The part holding the paragraphs of one text part, with their labels.

    Args:
        paragraphs: Paragraphs of one text part, in order.
        probabilities: Probabilities of the answers for each paragraph.
        questions: Questions the probabilities answer.

    Raises:
        ValueError: If the probabilities don't cover exactly the questions and
            their options, or don't make a valid part.
    """
    labels = [most_probable(span, questions) for span in probabilities]
    return AnnotatedPart(
        message_id=paragraphs[0].message_id,
        content_index=paragraphs[0].content_index,
        starts=[paragraph.start for paragraph in paragraphs],
        ends=[paragraph.end for paragraph in paragraphs],
        values={q.name: [span[q.name] for span in labels] for q in questions},
        probabilities={
            q.name: [
                [span[q.name][option] for option in q.options] for span in probabilities
            ]
            for q in questions
        },
    )


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


@scorer(metrics=ANNOTATION_METRICS)
def token_values(
    probes: Sequence[NumericField],
    run_probes: ProbeRunner,
    runner_name: str,
    tokenizer_name: str,
) -> Scorer:
    """Store each probe's value on every token of the sample's messages.

    Adds a layer with one numeric field per probe. Every non-empty text of
    every message gets values (see `text_parts`), rounded to `DECIMALS`
    decimals.

    Args:
        probes: Probes to run.
        run_probes: Gives the tokens and the probes' values for each part.
        runner_name: Name recorded as the layer's source, e.g. "fake probes".
        tokenizer_name: Tokenizer `run_probes` uses, e.g. "tiktoken/o200k_base".
    """
    probes = list(probes)

    def make_layer(parts: list[AnnotatedPart]) -> AnnotationLayer:
        return AnnotationLayer(
            name=TOKEN_LAYER,
            unit="token",
            source=runner_name,
            tokenizer=tokenizer_name,
            description="Values of probes on each token.",
            fields=[*probes],
            parts=parts,
        )

    # validates the probes now rather than at the first sample
    make_layer([])

    async def score(state: TaskState, target: Target) -> Score:
        sample = describe_sample(state)
        parts = text_parts(state.messages)
        results = await run_probes(parts, probes, state) if parts else []
        if len(results) != len(parts):
            raise ValueError(
                f"Probe runner {runner_name} gave {len(results)} results for "
                f"{len(parts)} text parts of {sample}"
            )
        annotated: list[AnnotatedPart] = []
        for part, result in zip(parts, results, strict=True):
            try:
                annotated_part = AnnotatedPart(
                    message_id=part.message_id,
                    content_index=part.content_index,
                    starts=[offset.start for offset in result.offsets],
                    ends=[offset.end for offset in result.offsets],
                    values={
                        name: [round(value, DECIMALS) for value in values]
                        for name, values in result.values.items()
                    },
                )
                check_spans_fit(annotated_part, part.text)
            except ValueError as ex:
                where = describe_part(part.message_id, part.content_index)
                raise ValueError(
                    f"Invalid probe values for the {where} of {sample}: {ex}"
                ) from ex
            annotated.append(annotated_part)
        return annotation_score([layer_for_sample(make_layer, annotated, sample)])

    return score


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
