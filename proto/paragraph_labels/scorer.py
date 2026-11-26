"""A scorer that labels each paragraph of a sample's transcript, and a fake classifier."""

import hashlib
import json
import math
import random
from collections.abc import Mapping, Sequence
from typing import Literal, Protocol

from inspect_ai.scorer import Metric, Score, Scorer, Target, mean, scorer, stderr
from inspect_ai.solver import TaskState

from .span_labels import (
    REASONING,
    ContentType,
    LabelledSpan,
    LabelQuestion,
    SpanLabels,
    check_probabilities,
    message_paragraphs,
)

SPAN_LABELS_KEY = "span_labels"
"""Key of the `SpanLabels` in the score's metadata."""

SPAN_LABEL_METRICS: dict[str, list[Metric]] = {"*": [mean(), stderr()]}
"""Mean number of spans per sample given each option of the first question."""

SpanProbabilities = dict[str, dict[str, float]]
"""Question name to the probability of each of its options, for one span."""


class SpanClassifier(Protocol):
    """Gives the probability of each answer to each question, for each span."""

    async def __call__(
        self, texts: list[str], questions: Sequence[LabelQuestion], state: TaskState
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


@scorer(metrics=SPAN_LABEL_METRICS)
def span_labels(
    questions: Sequence[LabelQuestion],
    classify: SpanClassifier,
    classifier_name: str,
    unit: Literal["paragraph"] = "paragraph",
    content_types: Sequence[ContentType] = REASONING,
) -> Scorer:
    """Label every paragraph of the assistant messages with a classifier.

    Each paragraph is labelled with the most probable option of each question
    (the earliest option on ties). The score's value maps each option of the
    first question to the number of paragraphs given it, and its metadata
    holds the `SpanLabels` under `span_labels`.

    To give the score its own name, wrap this in a `@scorer`-decorated factory
    with `metrics=SPAN_LABEL_METRICS` (the score takes the factory's name).

    Args:
        questions: Questions to answer about every paragraph.
        classify: Classifier giving the probabilities of the answers.
        classifier_name: Name recorded with the labels, e.g. "typesafe/jev-1.14".
        unit: What a span is. Only "paragraph" is supported.
        content_types: Kinds of content part to split into paragraphs.
    """
    if unit != "paragraph":
        raise ValueError(f"Unsupported span unit '{unit}' (expected 'paragraph')")
    questions = list(questions)
    # validates the questions now rather than at the first sample
    SpanLabels(unit=unit, classifier=classifier_name, questions=questions, spans=[])
    first = questions[0]

    async def score(state: TaskState, target: Target) -> Score:
        paragraphs = message_paragraphs(state.messages, content_types)
        texts = [paragraph.text for paragraph in paragraphs]
        probabilities = await classify(texts, questions, state) if texts else []
        if len(probabilities) != len(paragraphs):
            raise ValueError(
                f"Classifier {classifier_name} gave {len(probabilities)} results "
                f"for {len(paragraphs)} paragraphs of sample {state.sample_id}"
            )
        spans = [
            LabelledSpan(
                message_id=paragraph.message_id,
                content_index=paragraph.content_index,
                start=paragraph.start,
                end=paragraph.end,
                labels=most_probable(span_probabilities, questions),
                probabilities=span_probabilities,
            )
            for paragraph, span_probabilities in zip(
                paragraphs, probabilities, strict=True
            )
        ]
        labels = SpanLabels(
            unit=unit, classifier=classifier_name, questions=questions, spans=spans
        )
        counts = {option: 0 for option in first.options}
        for span in labels.spans:
            counts[span.labels[first.name]] += 1
        units = unit if len(spans) == 1 else f"{unit}s"
        return Score(
            value=counts,
            explanation=f"{len(spans)} {units} labelled by {classifier_name}",
            metadata={SPAN_LABELS_KEY: labels.model_dump()},
        )

    return score


def most_probable(
    probabilities: SpanProbabilities, questions: Sequence[LabelQuestion]
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
        check_probabilities(question, option_probabilities)
        labels[question.name] = max(
            question.options, key=option_probabilities.__getitem__
        )
    return labels


def random_classifier(
    seed: str = "", concentration: float = 0.5, yes_rate: float = 0.1
) -> SpanClassifier:
    """Random, plausible-looking probabilities, for building viewers and tests.

    Deterministic: each paragraph's draws come from a `random.Random` seeded
    with a SHA-256 digest of `seed`, the sample id, the epoch and the
    paragraph's index.

    The probabilities for a question are a Dirichlet draw (normalised gamma
    draws) with parameters `concentration * prior`, rounded to two decimals.
    A small concentration gives peaked distributions whose most probable
    option roughly follows the prior. For yes/no questions, whose options are
    "yes" and "no" or "1" and "0", the prior of "yes" or "1" is `yes_rate`;
    for other questions it falls off with the option's position (1, 1/2,
    1/3, ... normalised), so earlier options are more common.

    Args:
        seed: Extra seed text, e.g. the eval id, so that samples with the
            same id in different logs get different labels.
        concentration: Total of the Dirichlet parameters.
        yes_rate: Prior probability of "yes" or "1" for yes/no questions.
    """

    async def classify(
        texts: list[str], questions: Sequence[LabelQuestion], state: TaskState
    ) -> list[SpanProbabilities]:
        results: list[SpanProbabilities] = []
        for index in range(len(texts)):
            key = json.dumps([seed, state.sample_id, state.epoch, index])
            digest = hashlib.sha256(key.encode()).digest()
            rng = random.Random(int.from_bytes(digest[:8], "big"))
            results.append(
                {
                    question.name: _draw(rng, _prior(question, yes_rate), concentration)
                    for question in questions
                }
            )
        return results

    return classify


def _prior(question: LabelQuestion, yes_rate: float) -> dict[str, float]:
    for positive, negative in (("yes", "no"), ("1", "0")):
        if set(question.options) == {positive, negative}:
            return {positive: yes_rate, negative: 1.0 - yes_rate}
    weights = [1.0 / (position + 1) for position in range(len(question.options))]
    return {
        option: weight / sum(weights)
        for option, weight in zip(question.options, weights, strict=True)
    }


def _draw(
    rng: random.Random, prior: Mapping[str, float], concentration: float
) -> dict[str, float]:
    draws = {
        option: rng.gammavariate(concentration * weight, 1.0)
        for option, weight in prior.items()
    }
    total = sum(draws.values())
    if total == 0.0:
        # every draw underflowed: put all the mass on one option
        chosen = rng.choices(list(prior), weights=list(prior.values()))[0]
        draws = {option: float(option == chosen) for option in prior}
        total = 1.0
    return _round_hundredths({option: d / total for option, d in draws.items()})


def _round_hundredths(probabilities: dict[str, float]) -> dict[str, float]:
    """Round to two decimals so that they still sum to 1 (largest remainder)."""
    scaled = {option: p * 100 for option, p in probabilities.items()}
    hundredths = {option: math.floor(s) for option, s in scaled.items()}
    by_remainder = sorted(
        scaled, key=lambda option: scaled[option] - hundredths[option], reverse=True
    )
    for option in by_remainder[: max(0, 100 - sum(hundredths.values()))]:
        hundredths[option] += 1
    return {option: h / 100 for option, h in hundredths.items()}
