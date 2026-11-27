import math
from pathlib import Path
from typing import Any

import pandas as pd
import pytest

from inspect_ai.analysis import messages_df, samples_df
from inspect_ai.log import EvalSample, read_eval_log, write_eval_log
from inspect_ai.model import (
    ChatMessage,
    ChatMessageAssistant,
    ChatMessageSystem,
    ChatMessageUser,
    ContentReasoning,
    ContentText,
)
from inspect_ai.scorer import Score

from .analysis import (
    CATEGORICAL_FIELDS,
    SPAN_COLUMNS,
    Aggregation,
    align,
    roll_up,
    spans_df,
)
from .annotations import (
    TEXT_ANNOTATIONS_KEY,
    AnnotatedPart,
    AnnotationLayer,
    CategoricalField,
    NumericField,
)
from .examples.make_demo import make_demo
from .scorer import annotation_score

MESSAGES: list[ChatMessage] = [
    ChatMessageSystem(id="sys", content="Be brief."),
    ChatMessageUser(id="u1", content="Hello there.\n\nSecond paragraph."),
    ChatMessageAssistant(
        id="a1",
        content=[
            ContentReasoning(reasoning="Think one.\n\nThink two."),
            ContentText(text="Answer here."),
        ],
    ),
]

KIND = CategoricalField(
    name="kind", options=["work", "grader", "none"], negative=["none"]
)
FLAG = CategoricalField(name="flag", options=["yes", "maybe", "no"], negative=["no"])


def part(
    message_id: str,
    content_index: int | None,
    ranges: list[tuple[int, int]],
    values: dict[str, Any],
    probabilities: dict[str, list[list[float]]] | None = None,
) -> AnnotatedPart:
    return AnnotatedPart(
        message_id=message_id,
        content_index=content_index,
        starts=[start for start, _ in ranges],
        ends=[end for _, end in ranges],
        values=values,
        probabilities=probabilities or {},
    )


PARAGRAPHS = AnnotationLayer(
    name="paragraphs",
    unit="paragraph",
    source="test",
    fields=[KIND],
    parts=[
        part("sys", None, [(0, 9)], {"kind": ["work"]}),
        part("u1", None, [(0, 12), (14, 31)], {"kind": ["work", "none"]}),
        part(
            "a1",
            0,
            [(0, 10), (12, 22)],
            {"kind": ["grader", "none"]},
            {"kind": [[0.2, 0.7, 0.1], [0.1, 0.1, 0.8]]},
        ),
    ],
)

MONITOR = AnnotationLayer(
    name="monitor",
    unit="paragraph",
    source="test",
    fields=[NumericField(name="p")],
    parts=[
        part("a1", 0, [(0, 10), (12, 22)], {"p": [0.9, 0.1]}),
        part("a1", 1, [(0, 12)], {"p": [0.5]}),
    ],
)

# Tokens [12, 16) of u1 and [10, 12) of part 0 of a1 cross or lie between
# paragraphs, and part 1 of a1 has no paragraphs: these are in none.
TOKENS = AnnotationLayer(
    name="tokens",
    unit="token",
    source="test",
    fields=[NumericField(name="a"), FLAG],
    parts=[
        part(
            "u1",
            None,
            [(0, 5), (5, 12), (12, 16), (16, 20), (20, 25), (25, 31)],
            {
                "a": [1.0, 2.0, 50.0, 3.0, 4.0, 5.0],
                "flag": ["no", "no", "yes", "no", "yes", "no"],
            },
        ),
        part(
            "a1",
            0,
            [(0, 5), (5, 8), (8, 10), (10, 12), (12, 17), (17, 22)],
            {
                "a": [10.0, 20.0, 30.0, 99.0, 40.0, 50.0],
                "flag": ["maybe", "yes", "maybe", "yes", "yes", "maybe"],
            },
        ),
        part("a1", 1, [(0, 6), (6, 12)], {"a": [7.0, 8.0], "flag": ["yes", "yes"]}),
    ],
)


def make_sample(id: str | int, epoch: int, scores: dict[str, Score]) -> EvalSample:
    return EvalSample(
        id=id,
        epoch=epoch,
        uuid=f"uuid-{id}-{epoch}",
        input="Hello",
        target="",
        messages=MESSAGES,
        scores=scores,
    )


@pytest.fixture(scope="module")
def demo_log(tmp_path_factory: pytest.TempPathFactory) -> str:
    path = tmp_path_factory.mktemp("demo") / "demo.eval"
    make_demo(path)
    return str(path)


def write_log(demo_log: str, path: Path, samples: list[EvalSample]) -> str:
    """A log with the demo's header and these samples, with its own eval id."""
    log = read_eval_log(demo_log, header_only=True)
    log.eval.eval_id = f"eval-{path.stem}"
    log.samples = samples
    write_eval_log(log, str(path))
    return str(path)


@pytest.fixture
def logs(demo_log: str, tmp_path: Path) -> list[str]:
    """Two logs: the first with two samples, the second with one."""
    first = write_log(
        demo_log,
        tmp_path / "first.eval",
        [
            make_sample(
                "s1",
                1,
                {
                    "outcome": Score(value=1),
                    "probes": annotation_score([TOKENS]),
                    "labels": annotation_score([PARAGRAPHS]),
                    "monitor": annotation_score([MONITOR]),
                },
            ),
            make_sample(7, 2, {"labels": annotation_score([PARAGRAPHS])}),
        ],
    )
    second = write_log(
        demo_log,
        tmp_path / "second.eval",
        [make_sample("s3", 1, {"both": annotation_score([MONITOR, PARAGRAPHS])})],
    )
    return [first, second]


def values(column: pd.Series) -> list[Any]:
    """The column's values, with None for missing values."""
    return [None if pd.isna(value) else value for value in column]


def test_spans_df_columns_and_rows(logs: list[str]) -> None:
    spans = spans_df(logs)
    assert list(spans.columns) == [
        *SPAN_COLUMNS,
        "field_a",
        "field_flag",
        "field_kind",
        "field_p",
    ]
    # logs, then samples, then scores and layers in the order stored
    blocks = spans[["log", "id", "epoch", "score", "layer"]].drop_duplicates()
    assert blocks.values.tolist() == [
        [logs[0], "s1", 1, "probes", "tokens"],
        [logs[0], "s1", 1, "labels", "paragraphs"],
        [logs[0], "s1", 1, "monitor", "monitor"],
        [logs[0], "7", 2, "labels", "paragraphs"],
        [logs[1], "s3", 1, "both", "monitor"],
        [logs[1], "s3", 1, "both", "paragraphs"],
    ]
    paragraphs = spans[(spans["id"] == "s1") & (spans["layer"] == "paragraphs")]
    assert paragraphs["unit"].unique().tolist() == ["paragraph"]
    assert paragraphs["message_id"].tolist() == ["sys", "u1", "u1", "a1", "a1"]
    assert paragraphs["order"].tolist() == [1, 2, 2, 3, 3]
    assert paragraphs["role"].tolist() == [
        "system",
        "user",
        "user",
        "assistant",
        "assistant",
    ]
    assert values(paragraphs["content_index"]) == [None, None, None, 0, 0]
    assert paragraphs["start"].tolist() == [0, 0, 14, 0, 12]
    assert paragraphs["end"].tolist() == [9, 12, 31, 10, 22]
    assert paragraphs["span_index"].tolist() == [0, 1, 2, 3, 4]
    assert paragraphs["field_kind"].tolist() == [
        "work",
        "work",
        "none",
        "grader",
        "none",
    ]
    assert values(paragraphs["field_a"]) == [None] * 5
    tokens = spans[(spans["id"] == "s1") & (spans["layer"] == "tokens")]
    assert tokens["span_index"].tolist() == list(range(14))
    assert tokens["field_a"].tolist()[:3] == [1.0, 2.0, 50.0]
    assert values(tokens["field_kind"]) == [None] * 14
    assert spans["sample_id"].unique().tolist() == [
        "uuid-s1-1",
        "uuid-7-2",
        "uuid-s3-1",
    ]
    assert spans["eval_id"].unique().tolist() == ["eval-first", "eval-second"]
    assert str(spans["content_index"].dtype) == "int64[pyarrow]"
    assert str(spans["field_a"].dtype) == "double[pyarrow]"
    assert str(spans["field_kind"].dtype) == "string[pyarrow]"
    assert spans.attrs[CATEGORICAL_FIELDS] == {
        "tokens": {"flag": {"options": ["yes", "maybe", "no"], "negative": ["no"]}},
        "paragraphs": {
            "kind": {"options": ["work", "grader", "none"], "negative": ["none"]}
        },
    }


def test_spans_df_ids_join_onto_samples_df(logs: list[str]) -> None:
    spans = spans_df(logs)
    samples = samples_df(logs, quiet=True)
    joined = spans.merge(
        samples[["sample_id", "eval_id", "log", "id", "epoch"]],
        on="sample_id",
        suffixes=("", "_sample"),
    )
    assert len(joined) == len(spans)
    for column in ["eval_id", "log", "id", "epoch"]:
        assert (joined[column] == joined[f"{column}_sample"]).all()


def test_spans_df_order_and_ids_match_messages_df(demo_log: str) -> None:
    spans = spans_df(demo_log)
    messages = messages_df(demo_log, quiet=True)
    joined = spans.merge(
        messages[["sample_id", "message_id", "eval_id", "log", "order", "role"]],
        on=["sample_id", "message_id"],
        suffixes=("", "_message"),
    )
    assert len(joined) == len(spans)
    for column in ["eval_id", "log", "order", "role"]:
        assert (joined[column] == joined[f"{column}_message"]).all()


def test_spans_df_reads_a_directory_and_paths(logs: list[str]) -> None:
    from_directory = spans_df(Path(logs[0]).parent)
    assert set(from_directory["log"]) == set(logs)
    assert len(spans_df([Path(log) for log in logs])) == len(from_directory)


def test_spans_df_text(logs: list[str]) -> None:
    assert "text" not in spans_df(logs).columns
    spans = spans_df(logs, text=True)
    assert list(spans.columns[: len(SPAN_COLUMNS) + 1]) == [*SPAN_COLUMNS, "text"]
    paragraphs = spans[(spans["id"] == "s1") & (spans["layer"] == "paragraphs")]
    assert paragraphs["text"].tolist() == [
        "Be brief.",
        "Hello there.",
        "Second paragraph.",
        "Think one.",
        "Think two.",
    ]


def test_spans_df_probabilities(logs: list[str]) -> None:
    assert not any(c.startswith("prob_") for c in spans_df(logs).columns)
    spans = spans_df(logs, probabilities=True)
    probabilities = ["prob_kind_work", "prob_kind_grader", "prob_kind_none"]
    assert list(spans.columns[-3:]) == probabilities
    paragraphs = spans[(spans["id"] == "s1") & (spans["layer"] == "paragraphs")]
    assert values(paragraphs["prob_kind_grader"]) == [None, None, None, 0.7, 0.1]
    assert spans.loc[spans["layer"] != "paragraphs", probabilities].isna().all().all()


def test_spans_df_layers(logs: list[str]) -> None:
    spans = spans_df(logs, layers=["monitor"])
    assert spans["layer"].unique().tolist() == ["monitor"]
    assert list(spans.columns) == [*SPAN_COLUMNS, "field_p"]
    assert spans["span_index"].tolist() == [0, 1, 2, 0, 1, 2]
    with pytest.raises(TypeError, match="as a list"):
        spans_df(logs, layers="monitor")
    with pytest.raises(ValueError, match=r"No layers named \['tokenz'\]"):
        spans_df(logs, layers=["monitor", "tokenz"])


def test_spans_df_without_logs() -> None:
    spans = spans_df([], text=True)
    assert list(spans.columns) == [*SPAN_COLUMNS, "text"]
    assert spans.empty


def bad_layer(**changes: Any) -> dict[str, Any]:
    layer = MONITOR.model_dump()
    return {"version": 1, "layers": [layer | changes]}


@pytest.mark.parametrize(
    "annotations, message",
    [
        (bad_layer(unit=""), "unit"),
        (
            bad_layer(parts=[part("a1", 1, [(0, 13)], {"p": [0.5]}).model_dump()]),
            "past the end of its text",
        ),
        (
            bad_layer(parts=[part("zz", 0, [(0, 1)], {"p": [0.5]}).model_dump()]),
            "isn't a text part of the messages",
        ),
    ],
)
def test_spans_df_rejects_invalid_annotations(
    demo_log: str, tmp_path: Path, annotations: dict[str, Any], message: str
) -> None:
    log = write_log(
        demo_log,
        tmp_path / "bad.eval",
        [
            make_sample(
                "s1",
                3,
                {
                    "labels": annotation_score([PARAGRAPHS]),
                    "broken": Score(
                        value=0, metadata={TEXT_ANNOTATIONS_KEY: annotations}
                    ),
                },
            )
        ],
    )
    with pytest.raises(ValueError, match=message) as raised:
        spans_df(log)
    assert "score 'broken' of sample s1 (epoch 3)" in str(raised.value)
    assert log in str(raised.value)


def test_spans_df_rejects_a_field_both_categorical_and_numeric(
    demo_log: str, tmp_path: Path
) -> None:
    numeric_kind = MONITOR.model_copy(
        update={
            "name": "numeric kind",
            "fields": [NumericField(name="kind")],
            "parts": [part("a1", 1, [(0, 12)], {"kind": [0.5]})],
        }
    )
    log = write_log(
        demo_log,
        tmp_path / "clash.eval",
        [
            make_sample(
                "s1", 1, {"labels": annotation_score([PARAGRAPHS, numeric_kind])}
            )
        ],
    )
    with pytest.raises(ValueError, match="'kind' is categorical in layer 'paragraphs'"):
        spans_df(log)
    assert spans_df(log, layers=["numeric kind"])["field_kind"].tolist() == [0.5]


def test_align_keeps_spans_in_every_layer(logs: list[str]) -> None:
    spans = spans_df(logs, text=True, probabilities=True)
    aligned = align(spans, ["paragraphs", "monitor"])
    assert list(aligned.columns) == [
        *SPAN_COLUMNS,
        "text",
        "field_kind",
        "field_p",
        "prob_kind_work",
        "prob_kind_grader",
        "prob_kind_none",
    ]
    # sample 7 has no monitor layer; part 1 of a1 has no paragraphs
    assert aligned[["id", "message_id", "start", "end"]].values.tolist() == [
        ["s1", "a1", 0, 10],
        ["s1", "a1", 12, 22],
        ["s3", "a1", 0, 10],
        ["s3", "a1", 12, 22],
    ]
    assert aligned["layer"].unique().tolist() == ["paragraphs+monitor"]
    assert aligned["score"].tolist() == ["labels+monitor"] * 2 + ["both"] * 2
    assert aligned["unit"].unique().tolist() == ["paragraph"]
    assert aligned["span_index"].tolist() == [0, 1, 0, 1]
    assert aligned["field_kind"].tolist() == ["grader", "none"] * 2
    assert aligned["field_p"].tolist() == [0.9, 0.1] * 2
    assert aligned["prob_kind_grader"].tolist() == [0.7, 0.1] * 2
    assert aligned["text"].tolist() == ["Think one.", "Think two."] * 2
    assert (aligned.dtypes == spans[aligned.columns].dtypes).all()
    assert aligned.attrs[CATEGORICAL_FIELDS] == {
        "paragraphs+monitor": spans.attrs[CATEGORICAL_FIELDS]["paragraphs"]
    }


def test_align_recomputes_span_index_in_transcript_order(logs: list[str]) -> None:
    spans = spans_df(logs)
    aligned = align(spans, ["monitor", "paragraphs"])
    within_samples = spans.groupby("sample_id", sort=False).sample(
        frac=1, random_state=0
    )
    assert within_samples["span_index"].tolist() != spans["span_index"].tolist()
    shuffled = align(within_samples, ["monitor", "paragraphs"])
    pd.testing.assert_frame_equal(shuffled, aligned)
    first = align(spans, ["paragraphs", "monitor"])
    assert first["span_index"].tolist() == aligned["span_index"].tolist()


def test_align_of_one_layer_keeps_its_rows(logs: list[str]) -> None:
    spans = spans_df(logs, probabilities=True)
    paragraphs = spans[spans["layer"] == "paragraphs"]
    aligned = align(spans, ["paragraphs"])
    expected = paragraphs[
        [
            *SPAN_COLUMNS,
            "field_kind",
            "prob_kind_work",
            "prob_kind_grader",
            "prob_kind_none",
        ]
    ].reset_index(drop=True)
    pd.testing.assert_frame_equal(aligned, expected)


def test_align_rejects_fields_of_the_same_name(logs: list[str]) -> None:
    spans = spans_df(logs)
    copy = spans[spans["layer"] == "paragraphs"].assign(layer="copy")
    with pytest.raises(
        ValueError, match="'paragraphs' and 'copy' both have field 'kind'"
    ):
        align(pd.concat([spans, copy]), ["paragraphs", "copy"])


def test_align_rejects_bad_layers(logs: list[str]) -> None:
    spans = spans_df(logs)
    with pytest.raises(ValueError, match="No spans of layer 'nope'"):
        align(spans, ["paragraphs", "nope"])
    with pytest.raises(ValueError, match="repeated"):
        align(spans, ["paragraphs", "paragraphs"])
    with pytest.raises(TypeError):
        align(spans, "paragraphs")
    with pytest.raises(ValueError, match="more than one span at the same position"):
        align(pd.concat([spans, spans]), ["paragraphs", "monitor"])
    other_score = spans[spans["layer"] == "monitor"].assign(score="other", start=100)
    with pytest.raises(ValueError, match="'monitor' is in more than one score"):
        align(pd.concat([spans, other_score]), ["paragraphs", "monitor"])


NAN = math.nan


@pytest.mark.parametrize(
    "agg, expected",
    [
        ("mean", [NAN, 1.5, 4.0, 20.0, 45.0]),
        ("max", [NAN, 2.0, 5.0, 30.0, 50.0]),
        ("min", [NAN, 1.0, 3.0, 10.0, 40.0]),
        ("sum", [0.0, 3.0, 12.0, 60.0, 90.0]),
        ("count", [0.0, 2.0, 3.0, 3.0, 2.0]),
    ],
)
def test_roll_up_aggregates_numeric_fields(
    logs: list[str], agg: Aggregation, expected: list[float]
) -> None:
    spans = spans_df(logs, probabilities=True)
    rolled = roll_up(
        spans[spans["id"] == "s1"], fine="tokens", coarse="paragraphs", agg=agg
    )
    assert rolled["layer"].unique().tolist() == ["paragraphs"]
    assert rolled["span_index"].tolist() == [0, 1, 2, 3, 4]
    assert [NAN if v is None else v for v in values(rolled["field_a"])] == (
        pytest.approx(expected, nan_ok=True)
    )
    assert str(rolled["field_a"].dtype) == "double[pyarrow]"


def test_roll_up_takes_the_most_frequent_option_found(logs: list[str]) -> None:
    spans = spans_df(logs, text=True, probabilities=True)
    rolled = roll_up(spans[spans["id"] == "s1"], fine="tokens", coarse="paragraphs")
    assert list(rolled.columns) == [
        *SPAN_COLUMNS,
        "text",
        "field_kind",
        "field_a",
        "field_flag",
        "prob_kind_work",
        "prob_kind_grader",
        "prob_kind_none",
    ]
    # no tokens; only negative; one positive beats two negative; most frequent;
    # a tie goes to the earlier option
    assert values(rolled["field_flag"]) == [None, "no", "yes", "maybe", "yes"]
    assert rolled["field_kind"].tolist() == ["work", "work", "none", "grader", "none"]
    assert values(rolled["prob_kind_none"]) == [None, None, None, 0.1, 0.8]
    assert str(rolled["field_flag"].dtype) == "string[pyarrow]"
    assert rolled.attrs[CATEGORICAL_FIELDS] == {
        "paragraphs": {
            "kind": {"options": ["work", "grader", "none"], "negative": ["none"]},
            "flag": {"options": ["yes", "maybe", "no"], "negative": ["no"]},
        }
    }


def test_roll_up_composes_with_align(logs: list[str]) -> None:
    spans = spans_df(logs)
    rolled = roll_up(spans, fine="tokens", coarse="paragraphs", agg="max")
    combined = pd.concat([rolled, spans[spans["layer"] == "monitor"]])
    aligned = align(combined, ["paragraphs", "monitor"])
    assert aligned.loc[aligned["id"] == "s1", "field_a"].tolist() == [30.0, 50.0]
    assert aligned.loc[aligned["id"] == "s1", "field_p"].tolist() == [0.9, 0.1]
    # sample s3 has paragraphs but no tokens
    assert aligned.loc[aligned["id"] == "s3", "field_a"].isna().all()


def test_roll_up_needs_the_options_of_categorical_fields(logs: list[str]) -> None:
    spans = spans_df(logs)
    merged = spans.merge(samples_df(logs, quiet=True)[["sample_id"]], on="sample_id")
    with pytest.raises(ValueError, match="roll up before joining"):
        roll_up(merged, fine="tokens", coarse="paragraphs")
    rolled = roll_up(merged, fine="monitor", coarse="paragraphs")
    assert values(rolled.loc[rolled["id"] == "s1", "field_p"]) == [
        None,
        None,
        None,
        0.9,
        0.1,
    ]


def test_roll_up_rejects_bad_arguments(logs: list[str]) -> None:
    spans = spans_df(logs)
    median: Any = "median"
    with pytest.raises(ValueError, match="Unknown aggregation"):
        roll_up(spans, fine="tokens", coarse="paragraphs", agg=median)
    with pytest.raises(ValueError, match="into itself"):
        roll_up(spans, fine="tokens", coarse="tokens")
    with pytest.raises(ValueError, match="No spans of layer 'nope'"):
        roll_up(spans, fine="nope", coarse="paragraphs")
    copy = spans[spans["layer"] == "tokens"].assign(layer="copy")
    with pytest.raises(ValueError, match=r"both have fields \['a', 'flag'\]"):
        roll_up(pd.concat([spans, copy]), fine="copy", coarse="tokens")
