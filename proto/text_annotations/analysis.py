"""A table of annotated spans, for analysis with pandas.

`spans_df` reads the text annotations in eval logs into a data frame with one
row per span per annotation set per sample. Its `sample_id`, `eval_id` and
`log` columns are those of the `inspect_ai.analysis` data frames, so it joins
onto `samples_df` (on `sample_id`) and `messages_df` (on `sample_id` and
`message_id`). `align` puts side by side the fields of annotation sets that
annotate the same spans, and `roll_up` aggregates a set's values over the
spans of a coarser one, e.g. probe values on tokens over paragraphs. Both
take and give a table like `spans_df`'s, so they compose.

The columns, in order:

- `sample_id`, `eval_id`, `log`: as in `messages_df`.
- `id`, `epoch`: the sample's dataset id and epoch, as in `samples_df`.
- `score`, `annotation_set`, `unit`: the score holding the annotation set, and
  the set's name and unit (null if it has none).
- `message_id`, `message_index`, `role`, `content_index`, `start`, `end`:
  where the span is. `message_index` is the message's 0-based position in the
  sample's messages. It isn't `messages_df`'s `order`, which counts from 1
  over messages read from the model events (and so can include a model output
  that isn't in the sample's messages); join with `messages_df` on
  `message_id`. `content_index` is null for a message's string content.
- `span_index`: 0-based position of the span among its set's spans in the
  sample, in transcript order.
- `text` (with `text=True`): the span's text.
- `field_<name>` for each field: an option for a categorical field, a number
  for a numeric one, and null on rows of sets without that field.
- `prob_<field>_<option>` (with `probabilities=True`) for each option of each
  categorical field with probabilities, null on spans without them.

Columns are backed by Arrow types, as in `inspect_ai.analysis`. The options
and negative options of each set's categorical fields are kept in
`DataFrame.attrs[CATEGORICAL_FIELDS]`, for `roll_up`. pandas keeps `attrs`
when filtering or sorting but drops them when merging.
"""

from __future__ import annotations

import math
from collections import Counter
from collections.abc import Collection, Iterable, Sequence
from os import PathLike
from typing import TYPE_CHECKING, Literal, NamedTuple, TypeAlias, cast

from typing_extensions import TypedDict

from inspect_ai.analysis import EvalColumn, EvalInfo, SampleSummary, samples_df
from inspect_ai.log import EvalLogInfo, EvalSample, read_eval_log_sample

from .annotations import (
    TEXT_ANNOTATIONS_KEY,
    AnnotatedPart,
    AnnotationSet,
    CategoricalField,
    Role,
    TextAnnotations,
    set_texts,
    text_parts,
)

if TYPE_CHECKING:
    import numpy as np
    import numpy.typing as npt
    import pandas as pd
    import pyarrow as pa

LogPaths: TypeAlias = (
    PathLike[str] | str | EvalLogInfo | Sequence[PathLike[str] | str | EvalLogInfo]
)
"""Log files or directories, as `inspect_ai.analysis` functions take them."""

Aggregation = Literal["mean", "max", "min", "sum", "count"]
"""How `roll_up` aggregates a numeric field over the spans in a coarser span."""

AGGREGATIONS: tuple[Aggregation, ...] = ("mean", "max", "min", "sum", "count")

SPAN_COLUMNS = [
    "sample_id",
    "eval_id",
    "log",
    "id",
    "epoch",
    "score",
    "annotation_set",
    "unit",
    "message_id",
    "message_index",
    "role",
    "content_index",
    "start",
    "end",
    "span_index",
]
"""Columns of every span table, in order (`text` follows when it's read)."""

TEXT_COLUMN = "text"
FIELD_PREFIX = "field_"
PROBABILITY_PREFIX = "prob_"

POSITION = ["sample_id", "message_id", "content_index", "start", "end"]
"""Columns that say where a span is: spans of two sets are the same if these are."""

CATEGORICAL_FIELDS = "categorical_fields"
"""Key in `DataFrame.attrs` of each annotation set's categorical fields: set
name to field name to its `FieldOptions`."""

INTEGER_COLUMNS = {
    "epoch",
    "message_index",
    "content_index",
    "start",
    "end",
    "span_index",
}

EXCLUDED_FIELDS = {"events", "store"}
"""Sample fields that `spans_df` doesn't read: they're large and not needed."""


class FieldOptions(TypedDict):
    """Options of a categorical field, as kept in `DataFrame.attrs`."""

    options: list[str]
    negative: list[str]


SetFields = dict[str, dict[str, FieldOptions]]
"""Annotation set name to categorical field name to its options."""


class SampleKey(NamedTuple):
    """The ids of a sample in the span table."""

    sample_id: str
    eval_id: str
    log: str
    id: str
    epoch: int


class FieldColumn(NamedTuple):
    """Which annotation set first gave a field column its type."""

    numeric: bool
    annotation_set: str


def spans_df(
    logs: LogPaths,
    sets: Sequence[str] | None = None,
    text: bool = False,
    probabilities: bool = False,
) -> pd.DataFrame:
    """Read the text annotations of eval logs: one row per span per set per sample.

    Samples are read one at a time, in the order `samples_df` gives them, and
    each score's annotations are checked against the sample's messages. Rows
    are in the order of the logs, then the samples, then the scores and the
    annotation sets within each score, then the spans. See the module
    docstring for the columns.

    Args:
        logs: Log files or directories of logs.
        sets: Names of the annotation sets to read, or None for all.
        text: Add a `text` column with each span's text.
        probabilities: Add a `prob_<field>_<option>` column for each option
            of each categorical field with probabilities.

    Raises:
        TypeError: If `sets` is a string rather than a list of them.
        ValueError: If a score's annotations are invalid or don't fit the
            sample's messages (the message names the log, sample and score),
            fields of the same name are categorical in one set and numeric
            in another, or a set in `sets` isn't in any of the logs.
    """
    selected = None if sets is None else set(set_names(sets))
    table = SpanTable(text, probabilities)
    for key in sample_keys(logs):
        sample = read_eval_log_sample(
            key.log,
            id=key.id,
            epoch=key.epoch,
            resolve_attachments=True,
            exclude_fields=EXCLUDED_FIELDS,
        )
        table.add_sample(key, sample, selected)
    if selected is not None:
        missing = sorted(selected - table.sets_found)
        if missing:
            raise ValueError(
                f"No annotation sets named {missing} in the logs (found "
                f"{sorted(table.sets_found)})"
            )
    return table.data_frame()


def sample_keys(logs: LogPaths) -> list[SampleKey]:
    """The ids of the samples in the logs, as `samples_df` gives them."""
    columns = [
        EvalColumn("eval_id", path="eval.eval_id", required=True),
        *(column for column in EvalInfo if column.name == "log"),
        *(column for column in SampleSummary if column.name in ("id", "epoch")),
    ]
    samples = samples_df(logs, columns=columns, quiet=True)
    if samples.empty:
        return []
    return [
        SampleKey(str(sample_id), str(eval_id), str(log), str(id), int(epoch))
        for sample_id, eval_id, log, id, epoch in samples[
            ["sample_id", "eval_id", "log", "id", "epoch"]
        ].itertuples(index=False)
    ]


def set_names(sets: Sequence[str]) -> list[str]:
    """Check that annotation set names are a list of different names.

    Raises:
        TypeError: If `sets` is a string rather than a list of them.
        ValueError: If `sets` is empty or repeats a name.
    """
    if isinstance(sets, str):
        raise TypeError(f"Give annotation sets as a list, not the string {sets!r}")
    names = list(sets)
    if not names:
        raise ValueError("Give at least one annotation set")
    if len(set(names)) != len(names):
        raise ValueError(f"Annotation set names are repeated: {names}")
    return names


class MessagePosition(NamedTuple):
    """Where a message is in a sample's messages."""

    position: int
    """0-based position in the messages."""
    role: Role


def message_positions(sample: EvalSample) -> dict[str, MessagePosition]:
    """The position and role of each message with text, by message id."""
    positions: dict[str, MessagePosition] = {}
    for index, message in enumerate(sample.messages):
        for part in text_parts([message]):
            positions[part.message_id] = MessagePosition(index, part.role)
    return positions


class SpanTable:
    """Collects the columns of a span table, sample by sample."""

    def __init__(self, text: bool, probabilities: bool) -> None:
        self.text = text
        self.probabilities = probabilities
        names = [*SPAN_COLUMNS, TEXT_COLUMN] if text else SPAN_COLUMNS
        self.columns: dict[str, list[object]] = {name: [] for name in names}
        self.fields: dict[str, list[object]] = {}
        self.field_types: dict[str, FieldColumn] = {}
        self.probability_columns: dict[str, list[object]] = {}
        self.probability_sources: dict[str, tuple[str, str]] = {}
        self.categorical: SetFields = {}
        self.sets_found: set[str] = set()
        self.rows = 0

    def add_sample(
        self, key: SampleKey, sample: EvalSample, selected: Collection[str] | None
    ) -> None:
        """Add the spans of every selected annotation set of every score of a sample.

        Raises:
            ValueError: If a score's annotations are invalid or don't fit the
                messages, or a field's column would hold both options and
                numbers.
        """
        positions: dict[str, MessagePosition] | None = None
        for score_name, score in (sample.scores or {}).items():
            metadata = score.metadata or {}
            if TEXT_ANNOTATIONS_KEY not in metadata:
                continue
            try:
                annotations = TextAnnotations.model_validate(
                    metadata[TEXT_ANNOTATIONS_KEY]
                )
                sets = [
                    (annotation_set, set_texts(annotation_set, sample.messages))
                    for annotation_set in annotations.sets
                    if selected is None or annotation_set.name in selected
                ]
            except ValueError as ex:
                raise ValueError(
                    f"Invalid text annotations in score '{score_name}' of sample "
                    f"{key.id} (epoch {key.epoch}) in {key.log}: {ex}"
                ) from ex
            if positions is None:
                positions = message_positions(sample)
            for annotation_set, texts in sets:
                self.add_set(key, score_name, annotation_set, texts, positions)

    def add_set(
        self,
        key: SampleKey,
        score: str,
        annotation_set: AnnotationSet,
        texts: Sequence[str],
        positions: dict[str, MessagePosition],
    ) -> None:
        """Add the spans of an annotation set, whose parts fit `texts`."""
        self.sets_found.add(annotation_set.name)
        count = annotation_set.span_count()
        fixed = self.columns
        for name, value in [
            ("sample_id", key.sample_id),
            ("eval_id", key.eval_id),
            ("log", key.log),
            ("id", key.id),
            ("epoch", key.epoch),
            ("score", score),
            ("annotation_set", annotation_set.name),
            ("unit", annotation_set.unit),
        ]:
            fixed[name].extend([value] * count)
        fixed["span_index"].extend(range(count))
        for part, part_text in zip(annotation_set.parts, texts, strict=True):
            spans = len(part.starts)
            position = positions[part.message_id]
            fixed["message_id"].extend([part.message_id] * spans)
            fixed["message_index"].extend([position.position] * spans)
            fixed["role"].extend([position.role] * spans)
            fixed["content_index"].extend([part.content_index] * spans)
            fixed["start"].extend(part.starts)
            fixed["end"].extend(part.ends)
            if self.text:
                fixed[TEXT_COLUMN].extend(part_text[s:e] for s, e in part.ranges())
        values = self.field_values(annotation_set)
        extend_padded(self.fields, values, self.rows, count)
        if self.probabilities:
            extend_padded(
                self.probability_columns,
                self.probability_values(annotation_set),
                self.rows,
                count,
            )
        self.rows += count

    def field_values(self, annotation_set: AnnotationSet) -> dict[str, list[object]]:
        """Each field's column name and its values on the annotation set's spans.

        Raises:
            ValueError: If a field's column already holds values of the
                other type, from a set with a field of the same name.
        """
        values: dict[str, list[object]] = {}
        for field in annotation_set.fields:
            column = FIELD_PREFIX + field.name
            numeric = not isinstance(field, CategoricalField)
            first = self.field_types.setdefault(
                column, FieldColumn(numeric, annotation_set.name)
            )
            if first.numeric != numeric:
                raise ValueError(
                    f"Field '{field.name}' is {describe_type(first.numeric)} in "
                    f"annotation set '{first.annotation_set}' but "
                    f"{describe_type(numeric)} in annotation set "
                    f"'{annotation_set.name}', so they can't share a column: "
                    "choose one of the sets with `sets`"
                )
            if isinstance(field, CategoricalField):
                options = self.categorical.setdefault(
                    annotation_set.name, {}
                ).setdefault(field.name, FieldOptions(options=[], negative=[]))
                add_new(options["options"], field.options)
                add_new(options["negative"], field.negative)
            values[column] = [
                value
                for part in annotation_set.parts
                for value in part.values[field.name]
            ]
        return values

    def probability_values(
        self, annotation_set: AnnotationSet
    ) -> dict[str, list[object]]:
        """Each probability column of the annotation set and its values on its spans.

        Raises:
            ValueError: If two different fields and options give the same
                column name.
        """
        values: dict[str, list[object]] = {}
        for field in annotation_set.fields:
            if not isinstance(field, CategoricalField) or not any(
                field.name in part.probabilities for part in annotation_set.parts
            ):
                continue
            for index, option in enumerate(field.options):
                column = f"{PROBABILITY_PREFIX}{field.name}_{option}"
                source = self.probability_sources.setdefault(
                    column, (field.name, option)
                )
                if source != (field.name, option):
                    raise ValueError(
                        f"Option '{option}' of field '{field.name}' and option "
                        f"'{source[1]}' of field '{source[0]}' would both have "
                        f"column '{column}'"
                    )
                values[column] = [
                    probability
                    for part in annotation_set.parts
                    for probability in part_probabilities(part, field.name, index)
                ]
        return values

    def data_frame(self) -> pd.DataFrame:
        """The span table, with each set's categorical fields in its `attrs`."""
        import pandas as pd
        import pyarrow as pa

        arrays: dict[str, pa.Array] = {}
        for name, values in self.columns.items():
            arrays[name] = pa.array(
                values, pa.int64() if name in INTEGER_COLUMNS else pa.string()
            )
        for name, values in self.fields.items():
            numeric = self.field_types[name].numeric
            arrays[name] = pa.array(values, pa.float64() if numeric else pa.string())
        for name, values in self.probability_columns.items():
            arrays[name] = pa.array(values, pa.float64())
        df = pa.table(arrays).to_pandas(types_mapper=pd.ArrowDtype)
        df.attrs[CATEGORICAL_FIELDS] = self.categorical
        return df


def part_probabilities(part: AnnotatedPart, field: str, index: int) -> list[object]:
    """The probability of one option of a field on each span of a part (None without)."""
    rows = part.probabilities.get(field)
    if rows is None:
        return [None] * len(part.starts)
    return [row[index] for row in rows]


def extend_padded(
    columns: dict[str, list[object]],
    values: dict[str, list[object]],
    rows: int,
    count: int,
) -> None:
    """Add `count` rows to columns that start missing: null where `values` has no column.

    Args:
        columns: Columns so far, each with `rows` values.
        values: Values of the new rows, for some columns (maybe new ones).
        rows: Number of rows so far.
        count: Number of new rows.
    """
    for name in values:
        if name not in columns:
            columns[name] = [None] * rows
    for name, column in columns.items():
        column.extend(values.get(name, [None] * count))


def add_new(items: list[str], new: Iterable[str]) -> None:
    """Append the items of `new` that aren't in `items` yet."""
    items.extend(item for item in new if item not in items)


def describe_type(numeric: bool) -> str:
    return "numeric" if numeric else "categorical"


def align(spans: pd.DataFrame, sets: Sequence[str]) -> pd.DataFrame:
    """One row per span that is in every one of some annotation sets, with their fields.

    Spans are the same if they have the same `sample_id`, `message_id`,
    `content_index`, `start` and `end`. Each row keeps the position columns
    of the span table and the field and probability columns of every listed
    set. `annotation_set` is the sets' names joined with "+", `score` is
    their different scores joined with "+", `unit` is their different units
    joined with "+" (null if none of them has one), and `span_index` counts
    the aligned spans of each sample in transcript order.

    Args:
        spans: A span table, e.g. from `spans_df`.
        sets: Names of the annotation sets.

    Raises:
        TypeError: If `sets` is a string rather than a list of them.
        ValueError: If `sets` is empty or repeats a name, a set isn't in
            `spans` or has two spans at the same position in a sample (e.g.
            the same log is in `spans` twice), or two sets have a field of
            the same name.
    """
    names = set_names(sets)
    rows = [set_rows(spans, name) for name in names]
    own = [set_columns(set_spans) for set_spans in rows]
    owners: dict[str, str] = {}
    for name, columns in zip(names, own, strict=True):
        for column in columns:
            if column.startswith(FIELD_PREFIX) and column in owners:
                raise ValueError(
                    f"Annotation sets '{owners[column]}' and '{name}' both have "
                    f"field '{column.removeprefix(FIELD_PREFIX)}'"
                )
            owners[column] = name

    base = [column for column in span_columns(spans) if column not in ("score", "unit")]
    merged = rows[0][base + own[0]].assign(
        _score0=rows[0]["score"], _unit0=rows[0]["unit"]
    )
    for index in range(1, len(names)):
        set_spans = rows[index][[*POSITION, *own[index]]].assign(
            **{
                f"_score{index}": rows[index]["score"],
                f"_unit{index}": rows[index]["unit"],
            }
        )
        merged = merged.merge(set_spans, on=POSITION, how="inner")

    merged["annotation_set"] = "+".join(names)
    for column in ("score", "unit"):
        parts = merged[[f"_{column}{index}" for index in range(len(names))]]
        merged[column] = [join_distinct(row) for row in parts.itertuples(index=False)]
    merged = in_transcript_order(merged)
    merged["span_index"] = merged.groupby("sample_id", sort=False).cumcount()
    kept = set().union(*own)
    columns = span_columns(spans) + [c for c in spans.columns if c in kept]
    result = merged[columns].astype(spans[columns].dtypes.to_dict())
    fields = set_fields(spans)
    result.attrs[CATEGORICAL_FIELDS] = {
        "+".join(names): {
            field: options
            for name in names
            for field, options in fields.get(name, {}).items()
        }
    }
    return result


def join_distinct(values: Iterable[object]) -> str | None:
    """The distinct values that aren't null, joined with "+"; None if there are none.

    Args:
        values: Strings, or nulls (None, `pd.NA` or NaN).
    """
    found = [value for value in values if isinstance(value, str)]
    return "+".join(dict.fromkeys(found)) or None


def roll_up(
    spans: pd.DataFrame, fine: str, coarse: str, agg: Aggregation = "mean"
) -> pd.DataFrame:
    """A coarse annotation set's spans, with a fine set's fields aggregated over each.

    A fine span is in a coarse span if both are in the same sample, message
    and part, and the fine span starts at or after the coarse span's start
    and ends at or before its end. Fine spans that are in no coarse span are
    left out.

    Each numeric field of the fine set gives a column `field_<name>`: its
    values on the fine spans in each coarse span, aggregated with `agg`. A
    coarse span without fine spans gets 0 for "sum" and "count" and null
    otherwise. Each categorical field of the fine set gives the most
    frequent of its options that aren't negative on those spans, or the most
    frequent negative option if all are negative (the earlier option in the
    field's options on ties), and null if there are none.

    Args:
        spans: A span table, e.g. from `spans_df`, with the options of the
            fine set's categorical fields in its `attrs`.
        fine: Name of the annotation set whose values are aggregated, e.g.
            tokens.
        coarse: Name of the annotation set whose spans they are aggregated
            over, e.g. paragraphs.
        agg: How to aggregate numeric fields: "mean", "max", "min", "sum" or
            "count" (the number of fine spans with a value).

    Raises:
        ValueError: If `agg` isn't one of these, `fine` and `coarse` are the
            same, either isn't in `spans` or has two spans at the same
            position in a sample, the sets both have a field of the same
            name, or the options of one of the fine set's categorical fields
            aren't in `spans.attrs` (pandas drops them when merging data
            frames, so roll up first).
    """
    import pandas as pd
    import pyarrow as pa

    if agg not in AGGREGATIONS:
        raise ValueError(
            f"Unknown aggregation {agg!r} (expected one of {AGGREGATIONS})"
        )
    if fine == coarse:
        raise ValueError(f"Can't roll annotation set '{fine}' up into itself")
    fine_rows = set_rows(spans, fine)
    coarse_rows = set_rows(spans, coarse)
    coarse_columns = set_columns(coarse_rows)
    fine_fields = [
        column for column in set_columns(fine_rows) if column.startswith(FIELD_PREFIX)
    ]
    clash = [column for column in fine_fields if column in coarse_columns]
    if clash:
        raise ValueError(
            f"Annotation sets '{fine}' and '{coarse}' both have fields "
            f"{[column.removeprefix(FIELD_PREFIX) for column in clash]}"
        )
    fields = set_fields(spans)
    fine_options = fields.get(fine, {})
    categorical = {
        column: column.removeprefix(FIELD_PREFIX)
        for column in fine_fields
        if not pd.api.types.is_numeric_dtype(fine_rows[column])
    }
    for name in categorical.values():
        if name not in fine_options:
            raise ValueError(
                f"The options of field '{name}' of annotation set '{fine}' aren't "
                "in the span table's attrs: pandas drops them when merging data "
                "frames, so roll up before joining other tables"
            )

    containing = containing_spans(fine_rows, coarse_rows)
    inside = containing >= 0
    count = len(coarse_rows)
    rolled: dict[str, pa.Array] = {}
    for column in fine_fields:
        if column in categorical:
            options = fine_options[categorical[column]]
            labels = [
                None if pd.isna(value) else str(value) for value in fine_rows[column]
            ]
            rolled[column] = pa.array(
                most_frequent(containing, labels, options, count), pa.string()
            )
        else:
            numbers = fine_rows[column].to_numpy(dtype="float64", na_value=math.nan)
            aggregated = (
                pd.Series(numbers[inside])
                .groupby(containing[inside])
                .agg(agg)
                .reindex(
                    range(count), fill_value=0.0 if agg in ("sum", "count") else None
                )
            )
            rolled[column] = pa.array(
                aggregated.to_numpy(), pa.float64(), from_pandas=True
            )

    coarse_fields = [c for c in coarse_columns if c.startswith(FIELD_PREFIX)]
    coarse_probabilities = [c for c in coarse_columns if c not in coarse_fields]
    result = pd.concat(
        [
            coarse_rows[span_columns(spans) + coarse_fields],
            pd.DataFrame(
                {
                    column: pd.arrays.ArrowExtensionArray(array)
                    for column, array in rolled.items()
                },
                index=coarse_rows.index,
            ),
            coarse_rows[coarse_probabilities],
        ],
        axis="columns",
    )
    result.attrs[CATEGORICAL_FIELDS] = {
        coarse: fields.get(coarse, {})
        | {name: fine_options[name] for name in categorical.values()}
    }
    return result


def containing_spans(fine: pd.DataFrame, coarse: pd.DataFrame) -> npt.NDArray[np.int64]:
    """For each fine span, the row of the coarse span it's in, or -1 if none.

    The spans of one set in one part don't overlap, so the only coarse span
    that can hold a fine span is the last one starting at or before it.
    """
    import numpy as np
    import pandas as pd

    codes: dict[tuple[str, str, int], int] = {}

    def part_codes(rows: pd.DataFrame) -> npt.NDArray[np.int64]:
        keys = zip(
            rows["sample_id"],
            rows["message_id"],
            rows["content_index"].to_numpy(dtype="int64", na_value=-1),
            strict=True,
        )
        return np.array(
            [codes.setdefault(key, len(codes)) for key in keys], dtype=np.int64
        )

    fine_ends = fine["end"].to_numpy(dtype="int64")
    left = pd.DataFrame(
        {
            "part": part_codes(fine),
            "start": fine["start"].to_numpy(dtype="int64"),
            "fine_row": np.arange(len(fine)),
        }
    ).sort_values("start", kind="stable")
    right = pd.DataFrame(
        {
            "part": part_codes(coarse),
            "start": coarse["start"].to_numpy(dtype="int64"),
            "coarse_end": coarse["end"].to_numpy(dtype="int64"),
            "coarse_row": np.arange(len(coarse)),
        }
    ).sort_values("start", kind="stable")
    matched = pd.merge_asof(left, right, on="start", by="part", direction="backward")
    fine_row = matched["fine_row"].to_numpy()
    coarse_row = matched["coarse_row"].to_numpy(dtype="float64")
    coarse_end = matched["coarse_end"].to_numpy(dtype="float64")
    contained = ~np.isnan(coarse_row) & (fine_ends[fine_row] <= coarse_end)
    containing = np.full(len(fine), -1, dtype=np.int64)
    containing[fine_row[contained]] = coarse_row[contained].astype(np.int64)
    return containing


def most_frequent(
    containing: npt.NDArray[np.int64],
    values: Sequence[str | None],
    field: FieldOptions,
    count: int,
) -> list[str | None]:
    """The option `roll_up` gives each coarse span, from the values in it.

    Args:
        containing: Coarse span holding each fine span, or -1 for none.
        values: Option (or None) on each fine span.
        field: Options of the field.
        count: Number of coarse spans.
    """
    found: list[Counter[str]] = [Counter() for _ in range(count)]
    for coarse, value in zip(containing, values, strict=True):
        if coarse >= 0 and value is not None:
            found[coarse][value] += 1
    negative = set(field["negative"])
    rank = {option: index for index, option in enumerate(field["options"])}

    def choose(counts: Counter[str]) -> str | None:
        if not counts:
            return None
        return min(
            counts,
            key=lambda option: (
                option in negative,
                -counts[option],
                rank.get(option, len(rank)),
            ),
        )

    return [choose(counts) for counts in found]


def set_rows(spans: pd.DataFrame, annotation_set: str) -> pd.DataFrame:
    """The rows of one annotation set, with a fresh index.

    Raises:
        ValueError: If the set has no rows, is in more than one score of a
            sample, or has two spans at the same position in a sample.
    """
    rows = spans.loc[spans["annotation_set"] == annotation_set].reset_index(drop=True)
    if rows.empty:
        found = list(dict.fromkeys(spans["annotation_set"]))
        raise ValueError(
            f"No spans of annotation set '{annotation_set}' (found sets {found})"
        )
    scores = rows.groupby("sample_id", sort=False)["score"].unique()
    for sample_id, names in scores.items():
        if len(names) > 1:
            raise ValueError(
                f"Annotation set '{annotation_set}' is in more than one score of "
                f"sample {sample_id}: {list(names)}"
            )
    if rows.duplicated(subset=POSITION).any():
        raise ValueError(
            f"Annotation set '{annotation_set}' has more than one span at the same "
            "position in a sample: is a log in the table twice?"
        )
    return rows


def set_columns(rows: pd.DataFrame) -> list[str]:
    """The field and probability columns with values on some of the rows."""
    return [
        column
        for column in rows.columns
        if column.startswith((FIELD_PREFIX, PROBABILITY_PREFIX))
        and bool(rows[column].notna().any())
    ]


def span_columns(spans: pd.DataFrame) -> list[str]:
    """The span table's columns other than fields and probabilities, in order."""
    return [
        column for column in [*SPAN_COLUMNS, TEXT_COLUMN] if column in spans.columns
    ]


def set_fields(spans: pd.DataFrame) -> SetFields:
    """The categorical fields of each set, from the table's `attrs` (if there)."""
    return cast(SetFields, spans.attrs.get(CATEGORICAL_FIELDS, {}))


def in_transcript_order(spans: pd.DataFrame) -> pd.DataFrame:
    """The rows sorted by message, part and start within each sample.

    Samples stay in the order they first appear in.
    """
    first = dict.fromkeys(spans["sample_id"])
    rank = {sample_id: index for index, sample_id in enumerate(first)}
    return (
        spans.assign(_sample=spans["sample_id"].map(rank))
        .sort_values(
            ["_sample", "message_index", "content_index", "start"], kind="stable"
        )
        .drop(columns="_sample")
        .reset_index(drop=True)
    )
