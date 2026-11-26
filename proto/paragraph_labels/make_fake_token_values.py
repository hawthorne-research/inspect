"""Write copies of eval logs with fake per-token probe values, to build a viewer against.

Each log in `SOURCE_LOGS` is scored post hoc with `token_values`, using
`fake_probe_runner` and the probes in `FAKE_PROBES`, and written to the output
directory under the same file name, keeping the existing scores. The source
logs are only read, and their SHA-256 hashes are compared before and after.
Every written log is read back and checked, and the summary compares each
probe's values on its keywords with its values elsewhere, which shows that
values line up with the right tokens.

Run from the repository root:

    .venv/bin/python -m proto.paragraph_labels.make_fake_token_values \
        --source proto_data/source --output proto_data/token_values
"""

import argparse
import math
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import NamedTuple

from inspect_ai import score
from inspect_ai.log import EvalLog, EvalSample, read_eval_log, write_eval_log

from .make_fake_labels import file_hashes
from .token_scorer import (
    FAKE_PROBES,
    TOKEN_VALUES_KEY,
    fake_probe_runner,
    keyword_mask,
    token_values,
)
from .token_values import (
    TokenValues,
    check_covers,
    check_part_offsets,
    part_offsets,
    text_parts,
)

SCORE_NAME = "token_values"
"""Name of the new score (the name of the `token_values` scorer)."""

ENCODING = "o200k_base"
"""tiktoken encoding the fake probes tokenise with."""

TOKENIZER = f"tiktoken/{ENCODING}"

SOURCE_LOGS = (
    "2026-11-05T14-33-22-00-00_translation_ACTEZb5ARELuF5EoQfNgLK.eval",
    "2026-11-12T18-43-24-00-00_maze_BZ9HWUhYKDFWCxCJnq5nt7.eval",
    "2026-11-12T18-43-24-00-00_maze_nyKwGJrChiykxqwJikuYNr.eval",
)
"""Source log files to write copies of."""

PROBES = [fake.probe for fake in FAKE_PROBES]
FAKES = {fake.probe.name: fake for fake in FAKE_PROBES}


@dataclass
class ProbeStats:
    """Totals of one probe's values, overall and on keyword tokens."""

    count: int = 0
    total: float = 0.0
    minimum: float = math.inf
    maximum: float = -math.inf
    keyword_count: int = 0
    """Tokens that overlap a keyword of the probe."""
    keyword_total: float = 0.0

    def add(self, values: Sequence[float], mask: Sequence[bool]) -> None:
        """Add the values of one part, with whether each token is a keyword."""
        if not values:
            return
        self.count += len(values)
        self.total += math.fsum(values)
        self.minimum = min(self.minimum, min(values))
        self.maximum = max(self.maximum, max(values))
        keyword_values = [v for v, hit in zip(values, mask, strict=True) if hit]
        self.keyword_count += len(keyword_values)
        self.keyword_total += math.fsum(keyword_values)

    def merge(self, other: "ProbeStats") -> None:
        """Add another set of totals to these."""
        self.count += other.count
        self.total += other.total
        self.minimum = min(self.minimum, other.minimum)
        self.maximum = max(self.maximum, other.maximum)
        self.keyword_count += other.keyword_count
        self.keyword_total += other.keyword_total

    @property
    def mean(self) -> float:
        return self.total / self.count if self.count else math.nan

    @property
    def keyword_mean(self) -> float:
        return (
            self.keyword_total / self.keyword_count if self.keyword_count else math.nan
        )

    @property
    def other_count(self) -> int:
        return self.count - self.keyword_count

    @property
    def other_mean(self) -> float:
        other_total = self.total - self.keyword_total
        return other_total / self.other_count if self.other_count else math.nan


class LogSummary(NamedTuple):
    """What one written log holds."""

    file: str
    task: str
    size: int
    """Size of the written file in bytes."""
    samples: int
    parts: int
    tokens: int
    probes: dict[str, ProbeStats]
    """Probe name to the totals of its values."""


class SampleCheck(NamedTuple):
    """A checked sample's values and the text of each of its parts."""

    values: TokenValues
    texts: list[str]


def check_sample(source: EvalSample, scored: EvalSample) -> SampleCheck:
    """Check one scored sample against its source.

    Raises:
        ValueError: If an original score changed, the values don't validate,
            the parts aren't the sample's text parts, a part's tokens don't
            cover its text exactly, or the score's value isn't each probe's
            mean value.
    """
    where = f"sample {scored.id} (epoch {scored.epoch})"
    scores = scored.scores or {}
    for name, original in (source.scores or {}).items():
        if name not in scores or scores[name].model_dump() != original.model_dump():
            raise ValueError(f"Score '{name}' of {where} is missing or changed")
    new_score = scores[SCORE_NAME]
    values = TokenValues.model_validate((new_score.metadata or {})[TOKEN_VALUES_KEY])
    if values.tokenizer != TOKENIZER or values.probes != PROBES:
        raise ValueError(f"Tokenizer or probes of {where} aren't the expected ones")
    parts = text_parts(scored.messages)
    if [(p.message_id, p.content_index) for p in values.parts] != [
        (p.message_id, p.content_index) for p in parts
    ]:
        raise ValueError(f"Parts of {where} aren't its text parts in order")
    for value_part, part in zip(values.parts, parts, strict=True):
        check_part_offsets(value_part, part.text)
        check_covers(part.text, part_offsets(value_part))
    expected: dict[str, float] = {}
    for probe in PROBES:
        all_values = [v for p in values.parts for v in p.values[probe.name]]
        expected[probe.name] = sum(all_values) / len(all_values) if all_values else 0.0
    value = new_score.value
    if (
        not isinstance(value, dict)
        or list(value) != list(expected)
        or not all(
            isinstance(value[name], float)
            and math.isclose(value[name], mean, rel_tol=1e-9, abs_tol=1e-9)
            for name, mean in expected.items()
        )
    ):
        raise ValueError(f"Score value of {where} isn't each probe's mean value")
    return SampleCheck(values, [part.text for part in parts])


def check_log(source: EvalLog, output_path: Path) -> LogSummary:
    """Read a written log back, check it against its source, and total its values.

    Raises:
        ValueError: If the log doesn't hold the values and the original
            scores, or a sample fails `check_sample`.
    """
    scored = read_eval_log(str(output_path))
    scorer_names = [s.name for s in scored.eval.scorers or []]
    original_names = [s.name for s in source.eval.scorers or []]
    if scorer_names != [*original_names, SCORE_NAME]:
        raise ValueError(f"Scorers of {output_path.name} are {scorer_names}")
    if scored.results is None or not any(
        s.scorer == SCORE_NAME for s in scored.results.scores
    ):
        raise ValueError(f"Results of {output_path.name} have no {SCORE_NAME} metrics")
    sources = {(s.id, s.epoch): s for s in source.samples or []}
    samples = scored.samples or []
    if len(samples) != len(sources):
        raise ValueError(
            f"{output_path.name} has {len(samples)} samples, not {len(sources)}"
        )

    parts = tokens = 0
    stats = {probe.name: ProbeStats() for probe in PROBES}
    for sample in samples:
        values, texts = check_sample(sources[(sample.id, sample.epoch)], sample)
        for value_part, text in zip(values.parts, texts, strict=True):
            parts += 1
            tokens += len(value_part.starts)
            offsets = part_offsets(value_part)
            for name, probe_values in value_part.values.items():
                mask = keyword_mask(text, offsets, FAKES[name].keywords)
                stats[name].add(probe_values, mask)
    return LogSummary(
        file=output_path.name,
        task=scored.eval.task,
        size=output_path.stat().st_size,
        samples=len(samples),
        parts=parts,
        tokens=tokens,
        probes=stats,
    )


def make_token_values(
    source_dir: Path, output_dir: Path, files: Sequence[str] = SOURCE_LOGS
) -> list[LogSummary]:
    """Score the given logs in `source_dir` and write the copies to `output_dir`.

    Args:
        source_dir: Directory holding the source logs.
        output_dir: Directory to write the copies to.
        files: File names of the logs to score.

    Raises:
        ValueError: If the output directory is or is inside the source
            directory, a log isn't in the source directory, or a source file
            changed while scoring.
    """
    source_dir, output_dir = source_dir.resolve(), output_dir.resolve()
    if output_dir == source_dir or source_dir in output_dir.parents:
        raise ValueError(f"Output {output_dir} is or is inside the source directory")
    missing = [file for file in files if not (source_dir / file).is_file()]
    if missing:
        raise ValueError(f"Logs aren't in {source_dir}: {missing}")
    before = file_hashes(source_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    summaries: list[LogSummary] = []
    for file in files:
        source = read_eval_log(str(source_dir / file))
        runner = fake_probe_runner(seed=source.eval.eval_id, encoding_name=ENCODING)
        # the scorer calls no model, so a mock one avoids creating API clients
        scored = score(
            source,
            token_values(PROBES, runner, tokenizer_name=TOKENIZER),
            model="mockllm/model",
            action="append",
            display="none",
        )
        output_path = output_dir / file
        write_eval_log(scored, str(output_path))
        summaries.append(check_log(source, output_path))

    after = file_hashes(source_dir)
    if after != before:
        changed = sorted(set(before.items()) ^ set(after.items()))
        raise ValueError(f"Source files changed while scoring: {changed}")
    print(f"Source hashes unchanged: {len(after)} files in {source_dir}")
    return summaries


def combine(stats: Iterable[ProbeStats]) -> ProbeStats:
    """The totals of several sets of values together."""
    combined = ProbeStats()
    for item in stats:
        combined.merge(item)
    return combined


def print_summary(summaries: list[LogSummary]) -> None:
    """Print each log's counts and value ranges, then the alignment check.

    The alignment check gives, for each probe, its mean value on tokens that
    overlap one of its keywords and on all other tokens, over all logs. The
    fake values are `strength` higher on keywords, so a difference below half
    of that means the values don't line up with the tokens.
    """
    print(
        f"\n{'file':<66} {'task':<12} {'MB':>6} {'samples':>7} {'parts':>6} {'tokens':>8}"
    )
    for s in summaries:
        print(
            f"{s.file:<66} {s.task:<12} {s.size / 1e6:>6.1f} {s.samples:>7} "
            f"{s.parts:>6} {s.tokens:>8}"
        )
        for name, stats in s.probes.items():
            print(
                f"    {name:<20} min {stats.minimum:>7.3f}  mean {stats.mean:>7.3f}  "
                f"max {stats.maximum:>7.3f}"
            )
    print(
        f"Total: {sum(s.samples for s in summaries)} samples, "
        f"{sum(s.parts for s in summaries)} parts, "
        f"{sum(s.tokens for s in summaries)} tokens"
    )
    print("\nAlignment check (mean value on keyword tokens vs other tokens, all logs):")
    for probe in PROBES:
        stats = combine(s.probes[probe.name] for s in summaries)
        difference = stats.keyword_mean - stats.other_mean
        clear = difference > FAKES[probe.name].strength / 2
        verdict = "higher" if clear else "NOT CLEARLY HIGHER"
        print(
            f"    {probe.name:<20} keyword {stats.keyword_mean:>7.3f} "
            f"({stats.keyword_count} tokens)  other {stats.other_mean:>7.3f} "
            f"({stats.other_count} tokens)  difference {difference:>+7.3f}  {verdict}"
        )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Write copies of eval logs with fake per-token probe values."
    )
    parser.add_argument("--source", type=Path, default=Path("proto_data/source"))
    parser.add_argument("--output", type=Path, default=Path("proto_data/token_values"))
    args = parser.parse_args()
    print_summary(make_token_values(args.source, args.output))


if __name__ == "__main__":
    main()
