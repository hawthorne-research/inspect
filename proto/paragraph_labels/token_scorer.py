"""A scorer that stores per-token probe values for a sample, and a fake probe runner."""

import hashlib
import json
import math
import random
import re
from bisect import bisect_right
from collections.abc import Sequence
from typing import NamedTuple, Protocol

from inspect_ai.scorer import Metric, Score, Scorer, Target, mean, scorer, stderr
from inspect_ai.solver import TaskState

from .span_labels import TextRange
from .token_values import (
    TextPart,
    TokenProbe,
    TokenValues,
    TokenValuesPart,
    check_part_offsets,
    describe_part,
    text_parts,
    token_offsets,
)

TOKEN_VALUES_KEY = "token_values"
"""Key of the `TokenValues` in the score's metadata."""

TOKEN_VALUE_METRICS: dict[str, list[Metric]] = {"*": [mean(), stderr()]}
"""Mean over samples of each probe's mean value per sample."""

DECIMALS = 3
"""Decimals the stored values are rounded to."""


class PartValues(NamedTuple):
    """The tokens of one text part and each probe's value on each token."""

    offsets: list[TextRange]
    """Code-point range of each token in the part's text."""
    values: dict[str, list[float]]
    """Probe name to its value on each token."""


class ProbeRunner(Protocol):
    """Tokenises each text part and gives each probe's value on every token."""

    async def __call__(
        self, parts: list[TextPart], probes: Sequence[TokenProbe], state: TaskState
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


@scorer(metrics=TOKEN_VALUE_METRICS)
def token_values(
    probes: Sequence[TokenProbe], run_probes: ProbeRunner, tokenizer_name: str
) -> Scorer:
    """Store each probe's value on every token of the sample's messages.

    Every non-empty text of every message gets values (see `text_parts`),
    rounded to `DECIMALS` decimals. The score's value maps each probe name to
    its mean value over all tokens of the sample (0.0 if there are none),
    and its metadata holds the `TokenValues` under `token_values`.

    Args:
        probes: Probes to run.
        run_probes: Gives the tokens and the probes' values for each part.
        tokenizer_name: Tokenizer `run_probes` uses, e.g. "tiktoken/o200k_base".
    """
    probes = list(probes)
    # validates the probes now rather than at the first sample
    TokenValues(tokenizer=tokenizer_name, probes=probes, parts=[])

    async def score(state: TaskState, target: Target) -> Score:
        sample = f"sample {state.sample_id} (epoch {state.epoch})"
        parts = text_parts(state.messages)
        results = await run_probes(parts, probes, state) if parts else []
        if len(results) != len(parts):
            raise ValueError(
                f"Probe runner gave {len(results)} results for {len(parts)} text "
                f"parts of {sample}"
            )
        value_parts: list[TokenValuesPart] = []
        for part, result in zip(parts, results, strict=True):
            try:
                value_part = TokenValuesPart(
                    message_id=part.message_id,
                    content_index=part.content_index,
                    starts=[offset.start for offset in result.offsets],
                    ends=[offset.end for offset in result.offsets],
                    values={
                        name: [round(value, DECIMALS) for value in values]
                        for name, values in result.values.items()
                    },
                )
                check_part_offsets(value_part, part.text)
            except ValueError as ex:
                where = describe_part(part.message_id, part.content_index)
                raise ValueError(
                    f"Invalid probe values for the {where} of {sample}: {ex}"
                ) from ex
            value_parts.append(value_part)
        try:
            values = TokenValues(
                tokenizer=tokenizer_name, probes=probes, parts=value_parts
            )
        except ValueError as ex:
            raise ValueError(f"Invalid probe values for {sample}: {ex}") from ex
        tokens = sum(len(part.starts) for part in values.parts)
        return Score(
            value=probe_means(values),
            explanation=f"{plural(tokens, 'token')}, {plural(len(probes), 'probe')}",
            metadata={TOKEN_VALUES_KEY: values.model_dump()},
        )

    return score


def probe_means(values: TokenValues) -> dict[str, float]:
    """Each probe's mean value over all tokens of all parts (0.0 if none)."""
    means: dict[str, float] = {}
    for probe in values.probes:
        all_values = [v for part in values.parts for v in part.values[probe.name]]
        means[probe.name] = (
            math.fsum(all_values) / len(all_values) if all_values else 0.0
        )
    return means


def plural(count: int, noun: str) -> str:
    """E.g. "1 token" or "3 tokens"."""
    return f"{count} {noun}" if count == 1 else f"{count} {noun}s"


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

    probe: TokenProbe
    keywords: re.Pattern[str]
    """Words the probe responds to."""
    strength: float
    """Value added on tokens that overlap a keyword."""
    noise: float
    """Standard deviation of the AR(1) baseline."""


FAKE_PROBES = [
    *(
        FakeProbe(
            TokenProbe(
                name=f"eval_awareness_L{layer}",
                description=(
                    "Linear probe for evaluation awareness (the model thinks it "
                    f"is being tested) on the residual stream at layer {layer}."
                ),
                layer=layer,
            ),
            EVAL_AWARENESS_KEYWORDS,
            strength=strength,
            noise=noise,
        )
        for layer, strength, noise in [(16, 2.0, 1.3), (24, 4.0, 1.0), (32, 6.0, 0.7)]
    ),
    FakeProbe(
        TokenProbe(
            name="deception_L24",
            description="Linear probe for deception on the residual stream at layer 24.",
            layer=24,
        ),
        DECEPTION_KEYWORDS,
        strength=4.0,
        noise=1.0,
    ),
]
"""Probes of the fake runner: an evaluation awareness probe at three layers,
weaker and noisier at earlier layers, and a deception probe."""

AR_COEFFICIENT = 0.9
"""Coefficient of the AR(1) baseline: how much of a token's noise carries over."""

BIAS = -0.5
"""Added to every fake value, so that most tokens are negative."""

DECAY = 0.6
"""Factor the keyword boost falls by with each token after a keyword."""

DECAY_TOKENS = 5
"""Tokens after a keyword that still get a boost."""


def fake_probe_runner(
    seed: str = "",
    fakes: Sequence[FakeProbe] = FAKE_PROBES,
    encoding_name: str = "o200k_base",
) -> ProbeRunner:
    """Random, plausible-looking probe values, for building viewers and tests.

    Each value is `BIAS`, plus an AR(1) series with standard deviation
    `noise`, plus a keyword boost: tokens that overlap a keyword get
    `strength`, and the next `DECAY_TOKENS` tokens get it times `DECAY` per
    token. So values are high on and just after keywords, which shows whether
    the viewer lines values up with the right tokens.

    Deterministic: each part's values for a probe come from a `random.Random`
    seeded with a SHA-256 digest of `seed`, the sample id, the epoch, the
    message id, the content index and the probe name.

    Args:
        seed: Extra seed text, e.g. the eval id, so that samples with the
            same id in different logs get different values.
        fakes: Probes the runner can run, and how to make up their values.
        encoding_name: tiktoken encoding to tokenise with.
    """
    by_name = {fake.probe.name: fake for fake in fakes}

    async def fake_probes(
        parts: list[TextPart], probes: Sequence[TokenProbe], state: TaskState
    ) -> list[PartValues]:
        unknown = [probe.name for probe in probes if probe.name not in by_name]
        if unknown:
            raise ValueError(f"No fake values for probes {unknown}")
        results: list[PartValues] = []
        for part in parts:
            offsets = token_offsets(part.text, encoding_name)
            values: dict[str, list[float]] = {}
            for probe in probes:
                fake = by_name[probe.name]
                key = json.dumps(
                    [
                        seed,
                        state.sample_id,
                        state.epoch,
                        part.message_id,
                        part.content_index,
                        probe.name,
                    ]
                )
                digest = hashlib.sha256(key.encode()).digest()
                rng = random.Random(int.from_bytes(digest[:8], "big"))
                noise = ar1(rng, len(offsets), fake.noise)
                boost = keyword_boost(part.text, offsets, fake.keywords, fake.strength)
                values[probe.name] = [
                    BIAS + n + b for n, b in zip(noise, boost, strict=True)
                ]
            results.append(PartValues(offsets, values))
        return results

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
    """Whether each token overlaps a match of `keywords` in `text`.

    Args:
        text: Text the tokens come from.
        offsets: Tokens of the text, ascending and non-overlapping.
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
    """`strength` on tokens overlapping a keyword, decaying over the tokens after.

    The token `k` places after a keyword token gets `strength * DECAY**k`, up
    to `DECAY_TOKENS` places; where these overlap, a token gets the largest.
    """
    boost = [0.0] * len(offsets)
    for index, hit in enumerate(keyword_mask(text, offsets, keywords)):
        if not hit:
            continue
        for after in range(min(DECAY_TOKENS + 1, len(offsets) - index)):
            boost[index + after] = max(boost[index + after], strength * DECAY**after)
    return boost
