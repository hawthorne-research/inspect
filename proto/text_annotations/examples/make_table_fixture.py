"""Write the demo sample and its span table, for the viewer's span table tests.

The viewer builds the same span table as `spans_df` from a sample. This
script writes the demo log's sample as the viewer receives it, and the rows
`spans_df` gives for it (with text and probabilities), as two JSON files in
the viewer's annotation model:

- `demo-sample.json`: `{"header": {"eval_id": ..., "log": "demo.eval"},
  "sample": ...}`, the sample dumped with `model_dump(mode="json",
  exclude_none=True)`.
- `demo-spans.json`: the rows, as a list of objects, with `log` set to
  "demo.eval" and nulls for missing values.

The files must be the same on every run, but an eval gives new ids and times
each time. So before reading the sample, the log is made deterministic: the
messages get ids by position ("message-1", ...), the sample and eval get
fixed ids, times are removed, and the events (and the attachments they refer
to) are dropped, since the span table doesn't use them.

Run from the repository root:

    .venv/bin/python -m proto.text_annotations.examples.make_table_fixture
"""

import argparse
import json
import math
import tempfile
from pathlib import Path
from typing import NamedTuple

from pydantic import JsonValue

from inspect_ai.log import EvalLog, EvalSample, read_eval_log_sample, write_eval_log

from ..analysis import spans_df
from .make_demo import make_demo

FIXTURE_DIR = (
    Path(__file__).resolve().parents[3]
    / "src/inspect_ai/_view/ts-mono/packages/inspect-components/src/chat"
    / "annotations/model/fixtures"
)
"""Where the viewer's annotation model keeps its test fixtures."""

SAMPLE_FILE = "demo-sample.json"
SPANS_FILE = "demo-spans.json"

LOG_NAME = "demo.eval"
"""The log's name in the fixtures, in place of its temporary path."""

EVAL_ID = "demo-eval"
SAMPLE_UUID = "demo-sample"

TIMES = ("started_at", "completed_at", "total_time", "working_time")
"""Sample fields that hold times, which differ on every run."""


class TableFixture(NamedTuple):
    """The text of the two fixture files."""

    sample: str
    """Text of `demo-sample.json`."""
    spans: str
    """Text of `demo-spans.json`."""


def table_fixture() -> TableFixture:
    """Run the demo and give the text of the fixture files."""
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / LOG_NAME
        log = make_deterministic(make_demo(path))
        write_eval_log(log, str(path))
        [stored] = log.samples or []
        sample = read_eval_log_sample(str(path), id=stored.id, epoch=stored.epoch)
        spans = spans_df(str(path), text=True, probabilities=True)
    spans["log"] = LOG_NAME
    header = {"eval_id": log.eval.eval_id, "log": LOG_NAME}
    rows = [
        {name: json_value(value) for name, value in row.items()}
        for row in spans.to_dict(orient="records")
    ]
    sample_json = sample.model_dump(mode="json", exclude_none=True)
    return TableFixture(
        sample=to_json({"header": header, "sample": sample_json}),
        spans=to_json(rows),
    )


def make_deterministic(log: EvalLog) -> EvalLog:
    """The log, with the parts of its one sample that differ on every run fixed.

    Message ids become "message-<position>" everywhere they appear (the
    messages, the output and the annotations), the sample and eval get fixed
    ids, the times are removed, and the events and attachments are dropped.

    Raises:
        ValueError: If the log doesn't have exactly one sample.
    """
    if log.samples is None or len(log.samples) != 1:
        raise ValueError("The demo log should have exactly one sample")
    [sample] = log.samples
    ids: dict[str, str] = {
        message.id: f"message-{position}"
        for position, message in enumerate(sample.messages, start=1)
        if message.id is not None
    }
    data = {
        key: replace_strings(value, ids)
        for key, value in sample.model_dump(mode="json", exclude_none=True).items()
    }
    for name in TIMES:
        data.pop(name, None)
    output = data.get("output")
    if isinstance(output, dict):
        output.pop("time", None)
    data |= {"uuid": SAMPLE_UUID, "events": [], "attachments": {}}
    deterministic = log.model_copy(deep=True)
    deterministic.eval.eval_id = EVAL_ID
    deterministic.samples = [EvalSample.model_validate(data)]
    return deterministic


def replace_strings(value: JsonValue, replacements: dict[str, str]) -> JsonValue:
    """`value` with every string that is a key of `replacements` replaced."""
    if isinstance(value, str):
        return replacements.get(value, value)
    if isinstance(value, list):
        return [replace_strings(item, replacements) for item in value]
    if isinstance(value, dict):
        return {key: replace_strings(item, replacements) for key, item in value.items()}
    return value


def json_value(value: object) -> JsonValue:
    """A span table value as JSON: None for missing values (null or NaN).

    Raises:
        TypeError: If the value isn't a string, number or missing.
    """
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    if isinstance(value, str | int | float):
        return value
    raise TypeError(f"Unexpected value in the span table: {value!r}")


def to_json(value: object) -> str:
    """JSON text of a fixture, ending with a newline."""
    return json.dumps(value, indent=1) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Write the demo sample and its span table for the viewer's tests."
    )
    parser.add_argument("--output-dir", type=Path, default=FIXTURE_DIR)
    args = parser.parse_args()
    fixture = table_fixture()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for name, text in [(SAMPLE_FILE, fixture.sample), (SPANS_FILE, fixture.spans)]:
        path = args.output_dir / name
        path.write_text(text, encoding="utf-8")
        print(f"Wrote {path} ({len(text.encode())} bytes)")


if __name__ == "__main__":
    main()
