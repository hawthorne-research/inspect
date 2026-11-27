import type { ChatMessage, EvalSample } from "@tsmono/inspect-common/types";

import type { AnnotationField, CategoricalField } from "./format";
import {
  collectAnnotationLayers,
  spanText,
  type ResolvedLayer,
} from "./layers";

/** A field's column: `field_<name>`. */
export type FieldColumn = `field_${string}`;

/** An option's probability column: `prob_<field>_<option>`. */
export type ProbabilityColumn = `prob_${string}`;

/** A field column's cell: an option of a categorical field or the value of
 *  a numeric one; null on rows of layers without the field. */
export type FieldCell = string | number | null;

interface FieldColumns {
  [column: FieldColumn]: FieldCell;
  /** Null on spans without probabilities for the field. */
  [column: ProbabilityColumn]: number | null;
}

/**
 * A row of the span table: one span of one annotation layer of one sample,
 * with the columns of Python's `spans_df`. `start`/`end` are code-point
 * offsets, as stored.
 */
export interface SpanRow extends FieldColumns {
  /** The sample's `uuid`. */
  sample_id: string | null;
  eval_id: string;
  log: string;
  /** The sample's dataset id, as a string like `samples_df`'s. */
  id: string;
  epoch: number;
  /** The score that holds the layer. */
  score: string;
  layer: string;
  unit: string;
  message_id: string;
  /** The message's 1-based position in the sample's messages. */
  order: number;
  role: ChatMessage["role"];
  content_index: number | null;
  start: number;
  end: number;
  /** 0-based position among the layer's spans in the sample, in transcript
   *  order. */
  span_index: number;
  text?: string;
}

/** The options of a categorical field, which rows alone don't tell. */
export interface FieldOptions {
  options: readonly string[];
  negative: readonly string[];
}

/** Layer name to categorical field name to its options. */
export type LayerFields = Readonly<
  Record<string, Readonly<Record<string, FieldOptions>>>
>;

export interface SpanRowOptions {
  /** Add each span's text. */
  text?: boolean;
  /** Add a `prob_<field>_<option>` column per option of each categorical
   *  field that has probabilities. */
  probabilities?: boolean;
  /** Names of the layers to include; all by default. */
  layers?: readonly string[];
}

/** Where a sample comes from, as the log's header and location say. */
export interface SampleSource {
  evalId: string;
  log: string;
}

export interface SpanRows {
  rows: SpanRow[];
  /** The categorical fields of the rows' layers, for `rollUp`. */
  categoricalFields: LayerFields;
  /** One message per score or layer left out as invalid. */
  errors: string[];
}

/** The column of field `field`. */
export const fieldColumn = (field: string): FieldColumn => `field_${field}`;

/** The column of the probability of `option` of field `field`. */
export const probabilityColumn = (
  field: string,
  option: string
): ProbabilityColumn => `prob_${field}_${option}`;

/**
 * The span table of a sample's annotation layers: rows in layer order
 * (score order, then layer order within the score), then transcript order.
 * Every row has a column for every field of the included layers. Layers
 * that fail validation are left out with an error, as in
 * `collectAnnotationLayers`.
 */
export const spanRows = (
  sample: EvalSample,
  { evalId, log }: SampleSource,
  { text = false, probabilities = false, layers: only }: SpanRowOptions = {}
): SpanRows => {
  const collected = collectAnnotationLayers(sample.scores, sample.messages);
  const layers = only
    ? collected.layers.filter((layer) => only.includes(layer.name))
    : collected.layers;
  const blank = blankColumns(layers, probabilities);
  const rows: SpanRow[] = [];
  for (const layer of layers) {
    let spanIndex = 0;
    for (const part of layer.parts) {
      for (const [span, start] of part.codePointStarts.entries()) {
        const row: SpanRow = {
          sample_id: sample.uuid ?? null,
          eval_id: evalId,
          log,
          id: String(sample.id),
          epoch: sample.epoch,
          score: layer.score,
          layer: layer.name,
          unit: layer.unit,
          message_id: part.messageId,
          order: part.messagePosition + 1,
          role: part.role,
          content_index: part.contentIndex,
          start,
          end: part.codePointEnds[span] ?? start,
          span_index: spanIndex++,
          ...(text ? { text: spanText(part, span) } : {}),
          ...blank,
        };
        for (const field of layer.fields) {
          row[fieldColumn(field.name)] =
            (field.type === "categorical"
              ? part.labels.get(field.name)?.[span]
              : part.values.get(field.name)?.[span]) ?? null;
          if (!probabilities || field.type !== "categorical") continue;
          const distribution = part.probabilities.get(field.name)?.[span];
          if (!distribution) continue;
          for (const [i, option] of field.options.entries()) {
            row[probabilityColumn(field.name, option)] =
              distribution[i] ?? null;
          }
        }
        rows.push(row);
      }
    }
  }
  return {
    rows,
    categoricalFields: categoricalFields(layers),
    errors: collected.errors,
  };
};

/** A null cell for every field of `layers` and, when asked for, every
 *  option of their categorical fields that have probabilities. */
const blankColumns = (
  layers: readonly ResolvedLayer[],
  probabilities: boolean
): FieldColumns => {
  const blank: FieldColumns = {};
  for (const layer of layers) {
    for (const field of layer.fields) {
      blank[fieldColumn(field.name)] = null;
      if (probabilities && hasProbabilities(layer, field)) {
        for (const option of field.options) {
          blank[probabilityColumn(field.name, option)] = null;
        }
      }
    }
  }
  return blank;
};

const hasProbabilities = (
  layer: ResolvedLayer,
  field: AnnotationField
): field is CategoricalField =>
  field.type === "categorical" &&
  layer.parts.some((part) => part.probabilities.has(field.name));

/** Options of layers of the same name (in different scores) are merged, in
 *  the order first seen, as Python's `spans_df` does. */
const categoricalFields = (layers: readonly ResolvedLayer[]): LayerFields => {
  const fields: Record<string, Record<string, FieldOptions>> = {};
  for (const layer of layers) {
    for (const field of layer.fields) {
      if (field.type !== "categorical") continue;
      const byName = (fields[layer.name] ??= {});
      const known = byName[field.name];
      byName[field.name] = {
        options: union(known?.options ?? [], field.options),
        negative: union(known?.negative ?? [], field.negative),
      };
    }
  }
  return fields;
};

const union = (
  items: readonly string[],
  more: readonly string[]
): readonly string[] => [...new Set([...items, ...more])];

/** How `rollUp` combines a numeric field's values over the fine spans in a
 *  coarse span. */
export type Aggregation = "mean" | "max" | "min" | "sum" | "count";

/**
 * One row per span present in every one of `layers` (same sample, message,
 * content part and offsets), in transcript order, with the listed layers'
 * field and probability columns and no others. `layer` joins the names with
 * "+", `score` and `unit` join the layers' distinct values with "+", and
 * `span_index` counts each sample's aligned spans.
 *
 * Throws when `layers` is empty or repeats a name, a layer has no rows or
 * two spans at the same position, or two layers have a field of the same
 * name.
 */
export const alignLayers = (
  rows: readonly SpanRow[],
  layers: readonly string[]
): SpanRow[] => {
  checkLayerNames(layers);
  const [first, ...others] = layers.map((name) => layerRows(rows, name));
  if (!first) return [];
  const owners = new Map<FieldColumn, string>();
  for (const layer of [first, ...others]) {
    for (const column of layer.fields) {
      const owner = owners.get(column);
      if (owner !== undefined) throw fieldClash(owner, layer.name, [column]);
      owners.set(column, layer.name);
    }
  }

  const aligned: SpanRow[] = [];
  for (const row of first.rows) {
    const matches = others.map((layer) => layer.spans.get(spanKey(row)));
    if (!matches.every((match) => match !== undefined)) continue;
    const group = [row, ...matches];
    const merged: SpanRow = {
      ...spanColumns(row),
      score: joinDistinct(group.map((r) => r.score)),
      layer: layers.join("+"),
      unit: joinDistinct(group.map((r) => r.unit)),
    };
    copyColumns(merged, row, first);
    for (const [i, layer] of others.entries()) {
      const match = matches[i];
      if (match) copyColumns(merged, match, layer);
    }
    aligned.push(merged);
  }
  return renumbered(inTranscriptOrder(aligned));
};

/**
 * The `coarse` layer's rows, each with the `fine` layer's fields summarised
 * over the fine spans it contains (same sample, message and content part;
 * `fine.start >= coarse.start && fine.end <= coarse.end`), as Python's
 * `roll_up`. Rows keep the coarse layer's columns and gain the fine fields'.
 *
 * A numeric field is aggregated with `agg`; with no fine spans, "sum" and
 * "count" are 0 and the others null. A categorical field takes its most
 * frequent option other than its negative ones, or the most frequent
 * negative one when nothing else is there, the earlier option in the
 * field's options on ties; null with no fine spans. Its options come from
 * `fields` (see `SpanRows.categoricalFields`).
 *
 * Throws when `fine` and `coarse` are the same, either has no rows or two
 * spans at the same position, both have a field of the same name, or
 * `fields` lacks the options of one of the fine layer's categorical fields.
 */
export const rollUp = (
  rows: readonly SpanRow[],
  fine: string,
  coarse: string,
  agg: Aggregation,
  fields: LayerFields = {}
): SpanRow[] => {
  if (fine === coarse) {
    throw new Error(`Can't roll layer "${fine}" up into itself`);
  }
  const fineLayer = layerRows(rows, fine);
  const coarseLayer = layerRows(rows, coarse);
  const clash = fineLayer.fields.filter((c) => coarseLayer.fields.includes(c));
  if (clash.length > 0) throw fieldClash(fine, coarse, clash);

  const summaries = fineLayer.fields.map((column) => {
    if (fineLayer.rows.some((row) => typeof row[column] === "number")) {
      return { column, options: undefined };
    }
    const name = fieldName(column);
    const options = fields[fine]?.[name];
    if (!options) {
      throw new Error(
        `The options of field "${name}" of layer "${fine}" are not in the fields given`
      );
    }
    return { column, options };
  });

  const fineSpans = new Map<string, SpanRow[]>();
  for (const row of fineLayer.rows) {
    const key = partKeyOf(row);
    const spans = fineSpans.get(key);
    if (spans) spans.push(row);
    else fineSpans.set(key, [row]);
  }
  for (const spans of fineSpans.values()) {
    spans.sort((a, b) => a.start - b.start);
  }

  return coarseLayer.rows.map((row) => {
    const contained = containedSpans(fineSpans.get(partKeyOf(row)) ?? [], row);
    const rolled: SpanRow = spanColumns(row);
    copyColumns(rolled, row, coarseLayer);
    for (const { column, options } of summaries) {
      const cells = contained.map((span) => span[column] ?? null);
      rolled[column] = options
        ? mostFrequent(cells.filter(isString), options)
        : aggregate(cells.filter(isNumber), agg);
    }
    return rolled;
  });
};

const kFieldPrefix = "field_";

const fieldName = (column: FieldColumn): string =>
  column.slice(kFieldPrefix.length);

const isFieldColumn = (key: string): key is FieldColumn =>
  key.startsWith(kFieldPrefix);

const isProbabilityColumn = (key: string): key is ProbabilityColumn =>
  key.startsWith("prob_");

const isNumber = (cell: FieldCell): cell is number => typeof cell === "number";

const isString = (cell: FieldCell): cell is string => typeof cell === "string";

const checkLayerNames = (layers: readonly string[]): void => {
  if (layers.length === 0) throw new Error("No layers given");
  if (new Set(layers).size !== layers.length) {
    throw new Error(`Layer names are repeated: ${layers.join(", ")}`);
  }
};

const fieldClash = (
  layer: string,
  other: string,
  columns: readonly FieldColumn[]
): Error =>
  new Error(
    `Layers "${layer}" and "${other}" both have fields ${columns.map((c) => `"${fieldName(c)}"`).join(", ")}`
  );

interface LayerRows {
  name: string;
  rows: SpanRow[];
  /** Rows by `spanKey`. */
  spans: Map<string, SpanRow>;
  /** The field and probability columns the layer's rows fill: rows carry
   *  null columns for other layers' fields. */
  fields: FieldColumn[];
  probabilities: ProbabilityColumn[];
}

const layerRows = (rows: readonly SpanRow[], name: string): LayerRows => {
  const own = rows.filter((row) => row.layer === name);
  if (own.length === 0) {
    const found = [...new Set(rows.map((row) => row.layer))];
    throw new Error(
      `No spans of layer "${name}" (found layers ${found.map((l) => `"${l}"`).join(", ")})`
    );
  }
  const spans = new Map<string, SpanRow>();
  const fields = new Set<FieldColumn>();
  const probabilities = new Set<ProbabilityColumn>();
  for (const row of own) {
    const key = spanKey(row);
    if (spans.has(key)) {
      throw new Error(
        `Layer "${name}" has more than one span at the same position in a sample: is it in two scores, or is a sample in the rows twice?`
      );
    }
    spans.set(key, row);
    for (const key of Object.keys(row)) {
      if (isFieldColumn(key) && (row[key] ?? null) !== null) fields.add(key);
      if (isProbabilityColumn(key) && (row[key] ?? null) !== null) {
        probabilities.add(key);
      }
    }
  }
  return {
    name,
    rows: own,
    spans,
    fields: [...fields],
    probabilities: [...probabilities],
  };
};

/** A row's columns other than fields and probabilities. */
const spanColumns = ({
  sample_id,
  eval_id,
  log,
  id,
  epoch,
  score,
  layer,
  unit,
  message_id,
  order,
  role,
  content_index,
  start,
  end,
  span_index,
  text,
}: SpanRow): SpanRow => ({
  sample_id,
  eval_id,
  log,
  id,
  epoch,
  score,
  layer,
  unit,
  message_id,
  order,
  role,
  content_index,
  start,
  end,
  span_index,
  ...(text === undefined ? {} : { text }),
});

const copyColumns = (
  target: SpanRow,
  source: SpanRow,
  { fields, probabilities }: Pick<LayerRows, "fields" | "probabilities">
): void => {
  for (const column of fields) target[column] = source[column] ?? null;
  for (const column of probabilities) target[column] = source[column] ?? null;
};

// Samples are told apart by log, id and epoch as well as uuid, which samples
// of older logs don't have.
const sampleKey = (row: SpanRow): string =>
  JSON.stringify([row.log, row.sample_id, row.id, row.epoch]);

const partKeyOf = (row: SpanRow): string =>
  JSON.stringify([sampleKey(row), row.message_id, row.content_index]);

const spanKey = (row: SpanRow): string =>
  JSON.stringify([partKeyOf(row), row.start, row.end]);

/** Rows sorted by message, part and start within each sample; samples stay
 *  in the order they first appear in. */
const inTranscriptOrder = (rows: readonly SpanRow[]): SpanRow[] => {
  const samples = new Map<string, number>();
  for (const row of rows) {
    const key = sampleKey(row);
    if (!samples.has(key)) samples.set(key, samples.size);
  }
  const rank = (row: SpanRow): number => samples.get(sampleKey(row)) ?? 0;
  return [...rows].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      a.order - b.order ||
      (a.content_index ?? 0) - (b.content_index ?? 0) ||
      a.start - b.start
  );
};

/** `rows` with `span_index` counting 0, 1, ... within each sample. */
const renumbered = (rows: readonly SpanRow[]): SpanRow[] => {
  const counts = new Map<string, number>();
  return rows.map((row) => {
    const key = sampleKey(row);
    const index = counts.get(key) ?? 0;
    counts.set(key, index + 1);
    return { ...row, span_index: index };
  });
};

const joinDistinct = (values: readonly string[]): string =>
  [...new Set(values)].join("+");

/** The spans of `spans` (one part's, sorted by start; spans don't overlap)
 *  that lie within `outer`. */
const containedSpans = (
  spans: readonly SpanRow[],
  outer: SpanRow
): SpanRow[] => {
  let low = 0;
  let high = spans.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((spans[middle]?.start ?? 0) < outer.start) low = middle + 1;
    else high = middle;
  }
  const contained: SpanRow[] = [];
  for (let i = low; i < spans.length; i++) {
    const span = spans[i];
    if (!span || span.start >= outer.end) break;
    if (span.end <= outer.end) contained.push(span);
  }
  return contained;
};

const aggregate = (
  values: readonly number[],
  agg: Aggregation
): number | null => {
  if (agg === "count") return values.length;
  const sum = values.reduce((total, value) => total + value, 0);
  if (agg === "sum") return sum;
  if (values.length === 0) return null;
  if (agg === "mean") return sum / values.length;
  // Not Math.max(...values): a coarse span can hold more values than a
  // call takes arguments.
  const pick = agg === "max" ? Math.max : Math.min;
  return values.reduce((best, value) => pick(best, value));
};

const mostFrequent = (
  labels: readonly string[],
  { options, negative }: FieldOptions
): string | null => {
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  const isNegative = (option: string): number =>
    negative.includes(option) ? 1 : 0;
  const count = (option: string): number => counts.get(option) ?? 0;
  const rank = (option: string): number => {
    const index = options.indexOf(option);
    return index < 0 ? options.length : index;
  };
  const [best] = [...counts.keys()].sort(
    (a, b) =>
      isNegative(a) - isNegative(b) || count(b) - count(a) || rank(a) - rank(b)
  );
  return best ?? null;
};
