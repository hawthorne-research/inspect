import type { Score } from "@tsmono/inspect-common/types";
import { isRecord } from "@tsmono/util";

import {
  alignLayers,
  fieldColumn,
  layerId,
  rollUp,
  spanCountLabel,
  type Aggregation,
  type CategoricalField,
  type FieldCell,
  type FieldColumn,
  type LayerFields,
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
  alignedLayers,
  sampleKey,
  spanKey,
  type LayerInfo,
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

/** A field of a layer. */
export interface FieldRef {
  layer: string;
  field: string;
}

/** A numeric field drawn as a line over the x layer's spans. */
export interface SeriesParams extends FieldRef {
  /** How the field's values within each x span combine when its layer's
   *  spans are not the x layer's (they are rolled up onto them). */
  aggregation: Aggregation;
  /** Where to draw a dashed reference line on the series' axis. */
  reference: number | null;
  /** Fixed ends of the series' axis; null fits that end to the data. */
  min: number | null;
  max: number | null;
}

/** The parameters of the "along the transcript" view. */
export interface AlongTranscriptParams {
  /** The layer whose spans make the x axis: a sample's k-th span is at
   *  x = k. */
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

/** One span of the x layer in a panel. */
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
  /** The x layer's id in the sample (`layerId` of its score and name). */
  layerId: string;
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
  /** The field's layer has other spans than the x layer, so its values are
   *  rolled up onto the x layer's spans with `aggregation`. */
  rolledUp: boolean;
  domain: Domain;
  ticks: readonly number[];
}

export interface AlongTranscript {
  params: AlongTranscriptParams;
  /** What one x span is, e.g. "paragraph". */
  unit: string;
  groups: readonly PanelGroup[];
  /** The left axis's series first. */
  series: readonly SeriesAxis[];
  /** Takes the second series' values onto the first series' axis, which is
   *  the plot's y scale; null without a second series. */
  rightAxis: LinearMap | null;
  /** The plot's y domain. */
  yDomain: Domain;
  marker: { label: string; field: CategoricalField } | null;
  /** Samples without every chosen layer, which have no panel. */
  omitted: number;
}

/**
 * The "along the transcript" view of `table`: one panel per sample of
 * `samples` that has every chosen layer, with the series and markers over
 * the x layer's spans in transcript order. Fields of other layers join the
 * x layer's spans directly when the layers have the same spans
 * (`alignLayers`) and are rolled up onto them otherwise (`rollUp`). Panels
 * are grouped by their `groupBy` score's value and ordered by sample id and
 * epoch; series axes are shared across panels.
 *
 * Throws as `alignLayers` and `rollUp` do, e.g. when a sample has two
 * spans of a chosen layer at the same position.
 */
export const alongTranscript = (
  table: SpanTable,
  samples: readonly AnalyticsSample[],
  params: AlongTranscriptParams
): AlongTranscript => {
  const series = params.series.slice(0, kMaxSeries);
  const chosen = new Set([
    params.x,
    ...series.map((s) => s.layer),
    ...(params.marker ? [params.marker.layer] : []),
  ]);

  const present = new Map<string, Set<string>>();
  for (const row of table.rows) {
    const key = sampleKey(row.id, row.epoch);
    const layers = present.get(key) ?? new Set<string>();
    layers.add(row.layer);
    present.set(key, layers);
  }
  const shown = [...samples]
    .filter((sample) => {
      const layers = present.get(sampleKey(sample.id, sample.epoch));
      return layers !== undefined && [...chosen].every((l) => layers.has(l));
    })
    .sort(compareSamples);
  const keys = new Set(shown.map((s) => sampleKey(s.id, s.epoch)));
  const rows = table.rows.filter(
    (row) => chosen.has(row.layer) && keys.has(sampleKey(row.id, row.epoch))
  );

  const aligned = alignedLayers(rows, params.x);
  const join = (ref: FieldRef, aggregation: Aggregation) =>
    rows.length === 0
      ? new Map<string, FieldCell>()
      : cellsOnX(
          rows,
          params.x,
          ref,
          aligned.has(ref.layer) ? "aligned" : aggregation,
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
    if (row.layer !== params.x) continue;
    const key = sampleKey(row.id, row.epoch);
    const spans = xRows.get(key) ?? [];
    spans.push(row);
    xRows.set(key, spans);
  }

  const unit = table.layers.find((l) => l.name === params.x)?.unit ?? "span";
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
      layerId: score === undefined ? "" : layerId(score, params.x),
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
    const rolledUp = !aligned.has(s.layer);
    return {
      ...s,
      label: `${s.layer} · ${s.field}${rolledUp ? ` (${s.aggregation} per ${unit})` : ""}`,
      rolledUp,
      domain,
      ticks: ticks(domain),
    };
  });
  const [left, right] = axes;

  return {
    params,
    unit,
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
            label: `${params.marker.layer} · ${params.marker.field}`,
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
  fields: LayerFields
): Map<string, FieldCell> => {
  const column = fieldColumn(ref.field);
  if (ref.layer === x) {
    return new Map(
      rows
        .filter((row) => row.layer === x)
        .map((row) => [spanKey(row), row[column] ?? null])
    );
  }
  // Only the one field travels, so the layers' other fields can't clash.
  const input: SpanRow[] = [];
  for (const row of rows) {
    if (row.layer === x) input.push(withField(row, null));
    else if (row.layer === ref.layer) input.push(withField(row, column));
  }
  const joined =
    join === "aligned"
      ? alignLayers(input, [x, ref.layer])
      : rollUp(input, ref.layer, x, join, fields);
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
    layer: row.layer,
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
  fields: LayerFields,
  { layer, field }: FieldRef
): CategoricalField | undefined => {
  const options = fields[layer]?.[field];
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

/** The fields of `kind` of every layer. */
export const layerFields = (
  layers: readonly LayerInfo[],
  kind: "numeric" | "categorical"
): FieldRef[] =>
  layers.flatMap((layer) =>
    layer[kind].map((field) => ({ layer: layer.name, field }))
  );

/** The scores of `samples` that hold no annotation layer of `table`: what
 *  panels can be grouped by. */
export const sampleScores = (
  table: SpanTable,
  samples: readonly AnalyticsSample[]
): string[] => {
  const annotations = new Set(table.layers.flatMap((layer) => layer.scores));
  const names = new Set<string>();
  for (const sample of samples) {
    for (const name of Object.keys(sample.scores)) {
      if (!annotations.has(name)) names.add(name);
    }
  }
  return [...names];
};

/**
 * Parameters to start from: the first layer with a numeric field as x, that
 * field as the one series, the first categorical field of a layer with the
 * x layer's spans as markers, message boundaries, and the samples' score
 * when they have exactly one besides the annotation scores.
 */
export const defaultParams = (
  table: SpanTable,
  samples: readonly AnalyticsSample[]
): AlongTranscriptParams => {
  const x = table.layers.find((l) => l.numeric.length > 0) ?? table.layers[0];
  const field = x?.numeric[0];
  const aligned = x ? alignedLayers(table.rows, x.name) : new Set<string>();
  const markerLayer = table.layers.find(
    (l) => aligned.has(l.name) && l.categorical.length > 0
  );
  const markerField = markerLayer?.categorical[0];
  const [score, ...others] = sampleScores(table, samples);
  return {
    x: x?.name ?? "",
    series:
      x && field !== undefined
        ? [
            {
              layer: x.name,
              field,
              aggregation: "mean",
              reference: null,
              min: null,
              max: null,
            },
          ]
        : [],
    marker:
      markerLayer && markerField !== undefined
        ? { layer: markerLayer.name, field: markerField }
        : null,
    messageBoundaries: true,
    groupBy: score !== undefined && others.length === 0 ? score : null,
    columns: 2,
  };
};

/**
 * `stored` parameters (e.g. remembered from another log) checked against
 * `table` and `samples`: each that names a layer, field or score they
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
  const layers = new Map(table.layers.map((layer) => [layer.name, layer]));
  const { x, series, marker, messageBoundaries, groupBy, columns } = stored;
  const parsedSeries = parseSeries(series, layers);
  const parsedMarker =
    marker === null ? null : parseFieldRef(marker, layers, "categorical");
  return {
    x: typeof x === "string" && layers.has(x) ? x : fallback().x,
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
  layers: ReadonlyMap<string, LayerInfo>,
  kind: "numeric" | "categorical"
): FieldRef | undefined => {
  if (!isRecord(raw)) return undefined;
  const { layer, field } = raw;
  if (typeof layer !== "string" || typeof field !== "string") return undefined;
  return layers.get(layer)?.[kind].includes(field)
    ? { layer, field }
    : undefined;
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
  layers: ReadonlyMap<string, LayerInfo>
): SeriesParams[] | undefined => {
  if (!Array.isArray(raw) || raw.length > kMaxSeries) return undefined;
  const series: SeriesParams[] = [];
  for (const entry of raw) {
    const ref = parseFieldRef(entry, layers, "numeric");
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
