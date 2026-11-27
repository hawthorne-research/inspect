import type { Score } from "@tsmono/inspect-common/types";
import { isRecord } from "@tsmono/util";

import {
  alignSets,
  fieldColumn,
  rollUp,
  setId,
  spanCountLabel,
  spanNoun,
  type Aggregation,
  type CategoricalField,
  type FieldCell,
  type FieldColumn,
  type SetFields,
  type SpanPosition,
  type SpanRow,
} from "../../chat/annotations/model";

import {
  linearMap,
  niceDomain,
  ticks,
  type Domain,
  type LinearMap,
} from "./scales";
import {
  alignedSets,
  sampleKey,
  spanKey,
  type SetInfo,
  type SpanTable,
} from "./spanTable";

export type ScoreValue = Score["value"];

/** A sample as the sample list knows it: its identity and score values. */
export interface AnalyticsSample {
  id: string | number;
  epoch: number;
  /** Score values by scorer name. */
  scores: Readonly<Record<string, ScoreValue>>;
}

/** A field of an annotation set. */
export interface FieldRef {
  set: string;
  field: string;
}

/** A numeric field drawn as a line over the x set's spans. */
export interface SeriesParams extends FieldRef {
  /** How the field's values within each x span combine when its set's
   *  spans are not the x set's (they are rolled up onto them). */
  aggregation: Aggregation;
  /** Where to draw a dashed reference line on the series' axis. */
  reference: number | null;
  /** Fixed ends of the series' axis; null fits that end to the data. */
  min: number | null;
  max: number | null;
}

/** The parameters of the "along the transcript" view. */
export interface AlongTranscriptParams {
  /** The annotation set whose spans make the x axis: a sample's k-th span
   *  is at x = k. */
  x: string;
  /** At most two numeric fields: the first on the left axis, the second on
   *  its own axis on the right. */
  series: readonly SeriesParams[];
  /** A categorical field: a vertical rule marks each span whose option is
   *  not one of its negative options. */
  marker: FieldRef | null;
  /** Draw a rule between spans of different messages. */
  messageBoundaries: boolean;
  /** A score of the samples that titles the panels and groups them. */
  groupBy: string | null;
  columns: number;
}

export const kMaxSeries = 2;
export const kMaxColumns = 4;
export const kAggregations: readonly Aggregation[] = [
  "mean",
  "max",
  "min",
  "sum",
  "count",
];

/** One span of the x set in a panel. */
export interface PanelPoint {
  /** 1 for the sample's first span. */
  x: number;
  /** Each series' value, in series order; null where there is none. */
  values: readonly (number | null)[];
  /** The marker field's option; null without a marker field or value. */
  marker: string | null;
  /** Where the span is in the sample's messages. */
  position: SpanPosition;
  /** The message's 0-based position in the sample's messages. */
  messageIndex: number;
}

export interface PanelMarker {
  x: number;
  option: string;
}

/** One sample's plot. */
export interface Panel {
  sample: AnalyticsSample;
  /** The x set's id in the sample (`setId` of its score and name). */
  setId: string;
  title: string;
  spanCount: number;
  points: readonly PanelPoint[];
  /** Spans whose marker option is not negative. */
  markers: readonly PanelMarker[];
  /** Halfway between the last span of a message and the first span of the
   *  next. */
  boundaries: readonly number[];
}

export interface PanelGroup {
  /** The panels' value of the `groupBy` score; null when the panels are
   *  not grouped or have no value. */
  value: string | null;
  panels: readonly Panel[];
}

/** A series with its axis, shared by every panel. */
export interface SeriesAxis extends SeriesParams {
  label: string;
  /** The field's set has other spans than the x set, so its values are
   *  rolled up onto the x set's spans with `aggregation`. */
  rolledUp: boolean;
  domain: Domain;
  ticks: readonly number[];
}

export interface AlongTranscript {
  params: AlongTranscriptParams;
  /** What one x span is called, e.g. "paragraph" (`spanNoun` of the x
   *  set's unit). */
  spanNoun: string;
  groups: readonly PanelGroup[];
  /** The left axis's series first. */
  series: readonly SeriesAxis[];
  /** Takes the second series' values onto the first series' axis, which is
   *  the plot's y scale; null without a second series. */
  rightAxis: LinearMap | null;
  /** The plot's y domain. */
  yDomain: Domain;
  marker: { label: string; field: CategoricalField } | null;
  /** Samples without every chosen set, which have no panel. */
  omitted: number;
}

/**
 * The "along the transcript" view of `table`: one panel per sample of
 * `samples` that has every chosen set, with the series and markers over
 * the x set's spans in transcript order. Fields of other sets join the
 * x set's spans directly when the sets have the same spans
 * (`alignSets`) and are rolled up onto them otherwise (`rollUp`). Panels
 * are grouped by their `groupBy` score's value and ordered by sample id and
 * epoch; series axes are shared across panels.
 *
 * Throws as `alignSets` and `rollUp` do, e.g. when a sample has two
 * spans of a chosen set at the same position.
 */
export const alongTranscript = (
  table: SpanTable,
  samples: readonly AnalyticsSample[],
  params: AlongTranscriptParams
): AlongTranscript => {
  const series = params.series.slice(0, kMaxSeries);
  const chosen = new Set([
    params.x,
    ...series.map((s) => s.set),
    ...(params.marker ? [params.marker.set] : []),
  ]);

  const present = new Map<string, Set<string>>();
  for (const row of table.rows) {
    const key = sampleKey(row.id, row.epoch);
    const sets = present.get(key) ?? new Set<string>();
    sets.add(row.annotation_set);
    present.set(key, sets);
  }
  const shown = [...samples]
    .filter((sample) => {
      const sets = present.get(sampleKey(sample.id, sample.epoch));
      return sets !== undefined && [...chosen].every((name) => sets.has(name));
    })
    .sort(compareSamples);
  const keys = new Set(shown.map((s) => sampleKey(s.id, s.epoch)));
  const rows = table.rows.filter(
    (row) =>
      chosen.has(row.annotation_set) && keys.has(sampleKey(row.id, row.epoch))
  );

  const aligned = alignedSets(rows, params.x);
  const join = (ref: FieldRef, aggregation: Aggregation) =>
    rows.length === 0
      ? new Map<string, FieldCell>()
      : cellsOnX(
          rows,
          params.x,
          ref,
          aligned.has(ref.set) ? "aligned" : aggregation,
          table.categoricalFields
        );
  const seriesCells = series.map((s) => join(s, s.aggregation));
  // Rolling up a categorical field takes its most frequent option, whatever
  // the aggregation.
  const markerCells = params.marker ? join(params.marker, "mean") : undefined;
  const markerField = params.marker
    ? categoricalField(table.categoricalFields, params.marker)
    : undefined;

  const xRows = new Map<string, SpanRow[]>();
  for (const row of rows) {
    if (row.annotation_set !== params.x) continue;
    const key = sampleKey(row.id, row.epoch);
    const spans = xRows.get(key) ?? [];
    spans.push(row);
    xRows.set(key, spans);
  }

  const unit = table.sets.find((s) => s.name === params.x)?.unit ?? null;
  const noun = spanNoun(unit);
  const oneId = new Set(shown.map((s) => String(s.id))).size <= 1;
  const negative = markerField?.negative ?? [];
  const panels = shown.map((sample): Panel => {
    const spans = [...(xRows.get(sampleKey(sample.id, sample.epoch)) ?? [])];
    spans.sort((a, b) => a.span_index - b.span_index);
    const points = spans.map((row, i): PanelPoint => {
      const key = spanKey(row);
      return {
        x: i + 1,
        values: seriesCells.map((cells) => numberOrNull(cells.get(key))),
        marker: markerCells ? stringOrNull(markerCells.get(key)) : null,
        position: {
          messageId: row.message_id,
          contentIndex: row.content_index,
          start: row.start,
          end: row.end,
        },
        messageIndex: row.message_index,
      };
    });
    const score = spans[0]?.score;
    return {
      sample,
      setId: score === undefined ? "" : setId(score, params.x),
      title: panelTitle(
        sample,
        oneId,
        params.groupBy,
        spanCountLabel(points.length, unit)
      ),
      spanCount: points.length,
      points,
      markers: points.flatMap((p) =>
        p.marker !== null && !negative.includes(p.marker)
          ? [{ x: p.x, option: p.marker }]
          : []
      ),
      boundaries: params.messageBoundaries ? messageStarts(points) : [],
    };
  });

  const axes = series.map((s, i): SeriesAxis => {
    const values: number[] = s.reference === null ? [] : [s.reference];
    for (const panel of panels) {
      for (const point of panel.points) {
        const value = point.values[i];
        if (value !== null && value !== undefined) values.push(value);
      }
    }
    const domain = fixEnds(niceDomain(extent(values) ?? [0, 1]), s.min, s.max);
    const rolledUp = !aligned.has(s.set);
    return {
      ...s,
      label: `${s.set} · ${s.field}${rolledUp ? ` (${s.aggregation} per ${noun})` : ""}`,
      rolledUp,
      domain,
      ticks: ticks(domain),
    };
  });
  const [left, right] = axes;

  return {
    params,
    spanNoun: noun,
    groups:
      params.groupBy === null
        ? [{ value: null, panels }]
        : groupPanels(panels, params.groupBy),
    series: axes,
    rightAxis: left && right ? linearMap(right.domain, left.domain) : null,
    yDomain: left?.domain ?? [0, 1],
    marker:
      params.marker && markerField
        ? {
            label: `${params.marker.set} · ${params.marker.field}`,
            field: markerField,
          }
        : null,
    omitted: samples.length - shown.length,
  };
};

/** The cells of field `ref` on each of `x`'s spans, by `spanKey`. */
const cellsOnX = (
  rows: readonly SpanRow[],
  x: string,
  ref: FieldRef,
  join: Aggregation | "aligned",
  fields: SetFields
): Map<string, FieldCell> => {
  const column = fieldColumn(ref.field);
  if (ref.set === x) {
    return new Map(
      rows
        .filter((row) => row.annotation_set === x)
        .map((row) => [spanKey(row), row[column] ?? null])
    );
  }
  // Only the one field travels, so the sets' other fields can't clash.
  const input: SpanRow[] = [];
  for (const row of rows) {
    if (row.annotation_set === x) input.push(withField(row, null));
    else if (row.annotation_set === ref.set) input.push(withField(row, column));
  }
  const joined =
    join === "aligned"
      ? alignSets(input, [x, ref.set])
      : rollUp(input, ref.set, x, join, fields);
  return new Map(joined.map((row) => [spanKey(row), row[column] ?? null]));
};

/** `row`'s span columns and, when given, the one field column. */
const withField = (row: SpanRow, column: FieldColumn | null): SpanRow => {
  const slim: SpanRow = {
    sample_id: row.sample_id,
    eval_id: row.eval_id,
    log: row.log,
    id: row.id,
    epoch: row.epoch,
    score: row.score,
    annotation_set: row.annotation_set,
    unit: row.unit,
    message_id: row.message_id,
    message_index: row.message_index,
    role: row.role,
    content_index: row.content_index,
    start: row.start,
    end: row.end,
    span_index: row.span_index,
  };
  if (column) slim[column] = row[column] ?? null;
  return slim;
};

const categoricalField = (
  fields: SetFields,
  { set, field }: FieldRef
): CategoricalField | undefined => {
  const options = fields[set]?.[field];
  return options
    ? {
        type: "categorical",
        name: field,
        description: null,
        metadata: {},
        options: options.options,
        negative: options.negative,
      }
    : undefined;
};

const numberOrNull = (cell: FieldCell | undefined): number | null =>
  typeof cell === "number" ? cell : null;

const stringOrNull = (cell: FieldCell | undefined): string | null =>
  typeof cell === "string" ? cell : null;

const messageStarts = (points: readonly PanelPoint[]): number[] =>
  points.flatMap((point, i) => {
    const previous = points[i - 1];
    return previous && previous.messageIndex !== point.messageIndex
      ? [point.x - 0.5]
      : [];
  });

// Not Math.min(...values): a series can have more values than a call takes
// arguments.
const extent = (values: readonly number[]): Domain | undefined => {
  let lo = Infinity;
  let hi = -Infinity;
  for (const value of values) {
    if (value < lo) lo = value;
    if (value > hi) hi = value;
  }
  return lo <= hi ? [lo, hi] : undefined;
};

/** A score value as text; null when the sample has none. */
export const scoreText = (value: ScoreValue | undefined): string | null => {
  if (value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
};

const panelTitle = (
  sample: AnalyticsSample,
  oneId: boolean,
  groupBy: string | null,
  count: string
): string => {
  const name = oneId
    ? `epoch ${sample.epoch}`
    : `${sample.id} epoch ${sample.epoch}`;
  const value = groupBy === null ? null : scoreText(sample.scores[groupBy]);
  return `${name}${value === null ? "" : `: ${value}`}, ${count}`;
};

const naturally = (a: string, b: string): number =>
  a.localeCompare(b, undefined, { numeric: true });

const compareSamples = (a: AnalyticsSample, b: AnalyticsSample): number =>
  (typeof a.id === "number" && typeof b.id === "number"
    ? a.id - b.id
    : naturally(String(a.id), String(b.id))) || a.epoch - b.epoch;

/** Numbers and booleans in order, then text in natural order, then no
 *  value. */
const compareValues = (
  a: ScoreValue | undefined,
  b: ScoreValue | undefined
): number => {
  if (a === undefined || b === undefined) {
    return Number(a === undefined) - Number(b === undefined);
  }
  const rank = (v: ScoreValue) =>
    typeof v === "number" || typeof v === "boolean" ? 0 : 1;
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (rank(a) === 0) return Number(a) - Number(b);
  return naturally(scoreText(a) ?? "", scoreText(b) ?? "");
};

const groupPanels = (panels: readonly Panel[], score: string): PanelGroup[] => {
  const groups = new Map<string | null, Panel[]>();
  for (const panel of panels) {
    const value = scoreText(panel.sample.scores[score]);
    const group = groups.get(value) ?? [];
    group.push(panel);
    groups.set(value, group);
  }
  const first = (group: readonly Panel[]) => group[0]?.sample.scores[score];
  return [...groups]
    .sort(([, a], [, b]) => compareValues(first(a), first(b)))
    .map(([value, group]) => ({ value, panels: group }));
};

/** The fields of `kind` of every set. */
export const setFields = (
  sets: readonly SetInfo[],
  kind: "numeric" | "categorical"
): FieldRef[] =>
  sets.flatMap((set) => set[kind].map((field) => ({ set: set.name, field })));

/** The scores of `samples` that hold no annotation set of `table`: what
 *  panels can be grouped by. */
export const sampleScores = (
  table: SpanTable,
  samples: readonly AnalyticsSample[]
): string[] => {
  const annotations = new Set(table.sets.flatMap((set) => set.scores));
  const names = new Set<string>();
  for (const sample of samples) {
    for (const name of Object.keys(sample.scores)) {
      if (!annotations.has(name)) names.add(name);
    }
  }
  return [...names];
};

/**
 * Parameters to start from: the first set with a numeric field as x, that
 * field as the one series, the first categorical field of a set with the
 * x set's spans as markers, message boundaries, and the samples' score
 * when they have exactly one besides the annotation scores.
 */
export const defaultParams = (
  table: SpanTable,
  samples: readonly AnalyticsSample[]
): AlongTranscriptParams => {
  const x = table.sets.find((s) => s.numeric.length > 0) ?? table.sets[0];
  const field = x?.numeric[0];
  const aligned = x ? alignedSets(table.rows, x.name) : new Set<string>();
  const markerSet = table.sets.find(
    (s) => aligned.has(s.name) && s.categorical.length > 0
  );
  const markerField = markerSet?.categorical[0];
  const [score, ...others] = sampleScores(table, samples);
  return {
    x: x?.name ?? "",
    series:
      x && field !== undefined
        ? [
            {
              set: x.name,
              field,
              aggregation: "mean",
              reference: null,
              min: null,
              max: null,
            },
          ]
        : [],
    marker:
      markerSet && markerField !== undefined
        ? { set: markerSet.name, field: markerField }
        : null,
    messageBoundaries: true,
    groupBy: score !== undefined && others.length === 0 ? score : null,
    columns: 2,
  };
};

/**
 * `stored` parameters (e.g. remembered from another log) checked against
 * `table` and `samples`: each that names a set, field or score they
 * don't have, or is malformed, takes its value from `defaultParams`.
 */
export const resolveParams = (
  stored: unknown,
  table: SpanTable,
  samples: readonly AnalyticsSample[]
): AlongTranscriptParams => {
  let defaults: AlongTranscriptParams | undefined;
  const fallback = () => (defaults ??= defaultParams(table, samples));
  if (!isRecord(stored)) return fallback();
  const sets = new Map(table.sets.map((set) => [set.name, set]));
  const { x, series, marker, messageBoundaries, groupBy, columns } = stored;
  const parsedSeries = parseSeries(series, sets);
  const parsedMarker =
    marker === null ? null : parseFieldRef(marker, sets, "categorical");
  return {
    x: typeof x === "string" && sets.has(x) ? x : fallback().x,
    series: parsedSeries ?? fallback().series,
    marker: parsedMarker === undefined ? fallback().marker : parsedMarker,
    messageBoundaries:
      typeof messageBoundaries === "boolean"
        ? messageBoundaries
        : fallback().messageBoundaries,
    groupBy:
      groupBy === null
        ? null
        : typeof groupBy === "string" &&
            sampleScores(table, samples).includes(groupBy)
          ? groupBy
          : fallback().groupBy,
    columns:
      typeof columns === "number" &&
      Number.isInteger(columns) &&
      columns >= 1 &&
      columns <= kMaxColumns
        ? columns
        : fallback().columns,
  };
};

const parseFieldRef = (
  raw: unknown,
  sets: ReadonlyMap<string, SetInfo>,
  kind: "numeric" | "categorical"
): FieldRef | undefined => {
  if (!isRecord(raw)) return undefined;
  const { set, field } = raw;
  if (typeof set !== "string" || typeof field !== "string") return undefined;
  return sets.get(set)?.[kind].includes(field) ? { set, field } : undefined;
};

/** A finite number, or null for null or a missing value; undefined for
 *  anything else. */
const optionalNumber = (value: unknown): number | null | undefined => {
  if (value === null || value === undefined) return null;
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
};

/** `fitted` with the given ends fixed, unless that leaves no range. */
const fixEnds = (
  fitted: Domain,
  min: number | null,
  max: number | null
): Domain => {
  const lo = min ?? fitted[0];
  const hi = max ?? fitted[1];
  return lo < hi ? [lo, hi] : fitted;
};

const isAggregation = (value: unknown): value is Aggregation =>
  kAggregations.some((aggregation) => aggregation === value);

/** Undefined unless every entry is a valid series. */
const parseSeries = (
  raw: unknown,
  sets: ReadonlyMap<string, SetInfo>
): SeriesParams[] | undefined => {
  if (!Array.isArray(raw) || raw.length > kMaxSeries) return undefined;
  const series: SeriesParams[] = [];
  for (const entry of raw) {
    const ref = parseFieldRef(entry, sets, "numeric");
    if (!ref || !isRecord(entry)) return undefined;
    const { aggregation } = entry;
    if (!isAggregation(aggregation)) return undefined;
    // Settings stored before an option existed lack it: read that as null.
    const reference = optionalNumber(entry["reference"]);
    const min = optionalNumber(entry["min"]);
    const max = optionalNumber(entry["max"]);
    if (reference === undefined || min === undefined || max === undefined) {
      return undefined;
    }
    series.push({ ...ref, aggregation, reference, min, max });
  }
  return series;
};
