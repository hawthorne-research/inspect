"""A fake classifier and a fake probe runner, for building viewers and tests.

Both work on spans of any size, through `classifier_annotator` and
`probe_annotator`. The values are random but deterministic, and look
plausible: answers follow a prior, and probe values rise on keywords.
"""

import hashlib
import json
import math
import random
import re
from bisect import bisect_right
from collections.abc import Mapping, Sequence
from typing import NamedTuple

from inspect_ai.solver import TaskState

from .. import (
    CategoricalField,
    Classifier,
    NumericField,
    ProbeRunner,
    Span,
    SpanProbabilities,
    TextRange,
    probe_field,
    text_parts,
)
from ..annotations import describe_part


def seeded_random(*key: object) -> random.Random:
    """A `random.Random` seeded with a SHA-256 digest of `key` as JSON."""
    digest = hashlib.sha256(json.dumps(list(key)).encode()).digest()
    return random.Random(int.from_bytes(digest[:8], "big"))


def random_classifier(
    seed: str = "", concentration: float = 0.5, yes_rate: float = 0.1
) -> Classifier:
    """Random, plausible-looking probabilities.

    Deterministic: each span's draws come from `seeded_random(seed, sample
    id, epoch, index of the span in the sample)`.

    The probabilities for a question are a Dirichlet draw (normalised gamma
    draws) with parameters `concentration * prior`, rounded to two decimals.
    A small concentration gives peaked distributions whose most probable
    option roughly follows the prior. For yes/no questions (two options, one
    of them negative, as `binary_question` makes), the prior of the other
    option is `yes_rate`; for other questions it falls off with the option's
    position (1, 1/2, 1/3, ... normalised), so earlier options are more
    common.

    Args:
        seed: Extra seed text, e.g. the eval id, so that samples with the
            same id in different logs get different labels.
        concentration: Total of the Dirichlet parameters.
        yes_rate: Prior probability of the answer that isn't negative, for
            yes/no questions.
    """

    async def classify(
        texts: list[str], questions: Sequence[CategoricalField], state: TaskState
    ) -> list[SpanProbabilities]:
        results: list[SpanProbabilities] = []
        for index in range(len(texts)):
            rng = seeded_random(seed, state.sample_id, state.epoch, index)
            results.append(
                {
                    question.name: _draw(rng, _prior(question, yes_rate), concentration)
                    for question in questions
                }
            )
        return results

    return classify


def _prior(question: CategoricalField, yes_rate: float) -> dict[str, float]:
    if len(question.options) == 2 and len(question.negative) == 1:
        return {
            option: 1.0 - yes_rate if option in question.negative else yes_rate
            for option in question.options
        }
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


def keyword_pattern(stems: Sequence[str]) -> re.Pattern[str]:
    """A case-insensitive pattern for words starting with any of `stems`.

    A stem of several words, e.g. "cover up", matches any whitespace between
    them. A match runs to the end of the word.
    """
    alternatives = (r"\s+".join(map(re.escape, stem.split())) for stem in stems)
    return re.compile(rf"\b(?:{'|'.join(alternatives)})\w*", re.IGNORECASE)


EVAL_AWARENESS_KEYWORDS = keyword_pattern(
    [
        "test",
        "grader",
        "grading",
        "graded",
        "evaluat",
        "benchmark",
        "examin",
        "monitor",
        "being checked",
        "score",
    ]
)
DECEPTION_KEYWORDS = keyword_pattern(
    [
        "hide",
        "hidden",
        "conceal",
        "pretend",
        "secret",
        "lie",
        "lying",
        "mislead",
        "deceiv",
        "sneak",
        "cover up",
    ]
)


class FakeProbe(NamedTuple):
    """A probe and how `fake_probe_runner` makes up its values."""

    probe: NumericField
    keywords: re.Pattern[str]
    """Words the probe responds to."""
    strength: float
    """Value added on spans that overlap a keyword."""
    noise: float
    """Standard deviation of the AR(1) baseline."""


FAKE_PROBES = [
    *(
        FakeProbe(
            probe_field(
                f"eval_awareness_L{layer}",
                description=(
                    "Linear probe for evaluation awareness (the model thinks it "
                    f"is being tested) on the residual stream at layer {layer}."
                ),
                model_layer=layer,
            ),
            EVAL_AWARENESS_KEYWORDS,
            strength=strength,
            noise=noise,
        )
        for layer, strength, noise in [(16, 2.0, 1.3), (24, 4.0, 1.0), (32, 6.0, 0.7)]
    ),
    FakeProbe(
        probe_field(
            "deception_L24",
            description="Linear probe for deception on the residual stream at layer 24.",
            model_layer=24,
        ),
        DECEPTION_KEYWORDS,
        strength=4.0,
        noise=1.0,
    ),
]
"""Probes of the fake runner: an evaluation awareness probe at three layers,
weaker and noisier at earlier layers, and a deception probe."""

AR_COEFFICIENT = 0.9
"""Coefficient of the AR(1) baseline: how much of a span's noise carries over."""

BIAS = -0.5
"""Added to every fake value, so that most values are negative."""

DECAY = 0.6
"""Factor the keyword boost falls by with each span after a keyword."""

DECAY_SPANS = 5
"""Spans after a keyword that still get a boost."""


def fake_probe_runner(
    seed: str = "", fakes: Sequence[FakeProbe] = FAKE_PROBES
) -> ProbeRunner:
    """Random, plausible-looking probe values.

    Each value is `BIAS`, plus an AR(1) series with standard deviation
    `noise`, plus a keyword boost: spans that overlap a keyword get
    `strength`, and the next `DECAY_SPANS` spans get it times `DECAY` per
    span. So on tokens, values are high on and just after keywords, which
    shows whether the viewer lines values up with the right tokens.

    Deterministic: the values of a probe on the spans of one message part
    come from `seeded_random(seed, sample id, epoch, message id, content
    index, probe name)`. The series runs over a part's spans in the order
    given, which should be ascending.

    Args:
        seed: Extra seed text, e.g. the eval id, so that samples with the
            same id in different logs get different values.
        fakes: Probes the runner can run, and how to make up their values.
    """
    by_name = {fake.probe.name: fake for fake in fakes}

    async def fake_probes(
        spans: list[Span], probes: Sequence[NumericField], state: TaskState
    ) -> dict[str, list[float]]:
        unknown = [probe.name for probe in probes if probe.name not in by_name]
        if unknown:
            raise ValueError(f"No fake values for probes {unknown}")
        texts = {
            (p.message_id, p.content_index): p.text for p in text_parts(state.messages)
        }
        by_part: dict[tuple[str, int | None], list[int]] = {}
        for index, span in enumerate(spans):
            by_part.setdefault((span.message_id, span.content_index), []).append(index)
        values = {probe.name: [0.0] * len(spans) for probe in probes}
        for (message_id, content_index), indices in by_part.items():
            text = texts.get((message_id, content_index))
            if text is None:
                where = describe_part(message_id, content_index)
                raise ValueError(f"The {where} isn't a text part of the messages")
            offsets = [TextRange(spans[i].start, spans[i].end) for i in indices]
            for probe in probes:
                fake = by_name[probe.name]
                rng = seeded_random(
                    seed,
                    state.sample_id,
                    state.epoch,
                    message_id,
                    content_index,
                    probe.name,
                )
                noise = ar1(rng, len(offsets), fake.noise)
                boost = keyword_boost(text, offsets, fake.keywords, fake.strength)
                for index, n, b in zip(indices, noise, boost, strict=True):
                    values[probe.name][index] = BIAS + n + b
        return values

    return fake_probes


def ar1(rng: random.Random, count: int, std: float) -> list[float]:
    """An AR(1) series of `count` values, with standard deviation `std` throughout.

    Each value is `AR_COEFFICIENT` times the one before plus Gaussian noise,
    and the first is drawn from the stationary distribution.
    """
    innovation = std * math.sqrt(1.0 - AR_COEFFICIENT**2)
    series: list[float] = []
    value = rng.gauss(0.0, std)
    for _ in range(count):
        series.append(value)
        value = AR_COEFFICIENT * value + rng.gauss(0.0, innovation)
    return series


def keyword_mask(
    text: str, offsets: Sequence[TextRange], keywords: re.Pattern[str]
) -> list[bool]:
    """Whether each span overlaps a match of `keywords` in `text`.

    Args:
        text: Text the spans come from.
        offsets: Spans of the text, ascending and non-overlapping.
        keywords: Pattern to match.
    """
    ends = [offset.end for offset in offsets]
    mask = [False] * len(offsets)
    for match in keywords.finditer(text):
        index = bisect_right(ends, match.start())
        while index < len(offsets) and offsets[index].start < match.end():
            mask[index] = True
            index += 1
    return mask


def keyword_boost(
    text: str, offsets: Sequence[TextRange], keywords: re.Pattern[str], strength: float
) -> list[float]:
    """`strength` on spans overlapping a keyword, decaying over the spans after.

    The span `k` places after a keyword span gets `strength * DECAY**k`, up
    to `DECAY_SPANS` places; where these overlap, a span gets the largest.
    """
    boost = [0.0] * len(offsets)
    for index, hit in enumerate(keyword_mask(text, offsets, keywords)):
        if not hit:
            continue
        for after in range(min(DECAY_SPANS + 1, len(offsets) - index)):
            boost[index + after] = max(boost[index + after], strength * DECAY**after)
    return boost
