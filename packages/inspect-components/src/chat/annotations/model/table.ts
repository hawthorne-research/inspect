import type { ChatMessage, EvalSample } from "@tsmono/inspect-common/types";

import type { AnnotationField, CategoricalField } from "./format";
import { collectAnnotationSets, spanText, type ResolvedSet } from "./sets";

/** A field's column: `field_<name>`. */
export type FieldColumn = `field_${string}`;

/** An option's probability column: `prob_<field>_<option>`. */
export type ProbabilityColumn = `prob_${string}`;

/** A field column's cell: an option of a categorical field or the value of
 *  a numeric one; null on rows of sets without the field. */
export type FieldCell = string | number | null;

interface FieldColumns {
  [column: FieldColumn]: FieldCell;
  /** Null on spans without probabilities for the field. */
  [column: ProbabilityColumn]: number | null;
}

/**
 * A row of the span table: one span of one annotation set of one sample,
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
  /** The score that holds the annotation set. */
  score: string;
  annotation_set: string;
  /** The set's unit; null when it has none (see `spanNoun`). */
  unit: string | null;
  message_id: string;
  /** The message's 0-based position in the sample's messages (not
   *  Inspect's `messages_df` `order`, which counts from 1 over the model
   *  events' messages). */
  message_index: number;
  role: ChatMessage["role"];
  content_index: number | null;
  start: number;
  end: number;
  /** 0-based position among the set's spans in the sample, in transcript
   *  order. */
  span_index: number;
  text?: string;
}

/** The options of a categorical field, which rows alone don't tell. */
export interface FieldOptions {
  options: readonly string[];
  negative: readonly string[];
}

/** Annotation set name to categorical field name to its options. */
export type SetFields = Readonly<
  Record<string, Readonly<Record<string, FieldOptions>>>
>;

export interface SpanRowOptions {
  /** Add each span's text. */
  text?: boolean;
  /** Add a `prob_<field>_<option>` column per option of each categorical
   *  field that has probabilities. */
  probabilities?: boolean;
  /** Names of the sets to include; all by default. */
  sets?: readonly string[];
}

/** Where a sample comes from, as the log's header and location say. */
export interface SampleSource {
  evalId: string;
  log: string;
}

export interface SpanRows {
  rows: SpanRow[];
  /** The categorical fields of the rows' sets, for `rollUp`. */
  categoricalFields: SetFields;
  /** One message per score or set left out as invalid. */
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
 * The span table of a sample's annotation sets: rows in set order (score
 * order, then set order within the score), then transcript order. Every
 * row has a column for every field of the included sets. Sets
 * that fail validation are left out with an error, as in
 * `collectAnnotationSets`.
 */
export const spanRows = (
  sample: EvalSample,
  { evalId, log }: SampleSource,
  { text = false, probabilities = false, sets: only }: SpanRowOptions = {}
): SpanRows => {
  const collected = collectAnnotationSets(sample.scores, sample.messages);
  const sets = only
    ? collected.sets.filter((set) => only.includes(set.name))
    : collected.sets;
  const blank = blankColumns(sets, probabilities);
  const rows: SpanRow[] = [];
  for (const set of sets) {
    let spanIndex = 0;
    for (const part of set.parts) {
      for (const [span, start] of part.codePointStarts.entries()) {
        const row: SpanRow = {
          sample_id: sample.uuid ?? null,
          eval_id: evalId,
          log,
          id: String(sample.id),
          epoch: sample.epoch,
          score: set.score,
          annotation_set: set.name,
          unit: set.unit,
          message_id: part.messageId,
          message_index: part.messagePosition,
          role: part.role,
          content_index: part.contentIndex,
          start,
          end: part.codePointEnds[span] ?? start,
          span_index: spanIndex++,
          ...(text ? { text: spanText(part, span) } : {}),
          ...blank,
        };
        for (const field of set.fields) {
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
    categoricalFields: categoricalFields(sets),
    errors: collected.errors,
  };
};

/** A null cell for every field of `sets` and, when asked for, every
 *  option of their categorical fields that have probabilities. */
const blankColumns = (
  sets: readonly ResolvedSet[],
  probabilities: boolean
): FieldColumns => {
  const blank: FieldColumns = {};
  for (const set of sets) {
    for (const field of set.fields) {
      blank[fieldColumn(field.name)] = null;
      if (probabilities && hasProbabilities(set, field)) {
        for (const option of field.options) {
          blank[probabilityColumn(field.name, option)] = null;
        }
      }
    }
  }
  return blank;
};

const hasProbabilities = (
  set: ResolvedSet,
  field: AnnotationField
): field is CategoricalField =>
  field.type === "categorical" &&
  set.parts.some((part) => part.probabilities.has(field.name));

/** Options of sets of the same name (in different scores) are merged, in
 *  the order first seen, as Python's `spans_df` does. */
const categoricalFields = (sets: readonly ResolvedSet[]): SetFields => {
  const fields: Record<string, Record<string, FieldOptions>> = {};
  for (const set of sets) {
    for (const field of set.fields) {
      if (field.type !== "categorical") continue;
      const byName = (fields[set.name] ??= {});
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
 * One row per span present in every one of `sets` (same sample, message,
 * content part and offsets), in transcript order, with the listed sets'
 * field and probability columns and no others. `annotation_set` joins the
 * names with "+", `score` and `unit` join the sets' distinct values with "+"
 * (units that are null left out, and null if all are), and
 * `span_index` counts each sample's aligned spans.
 *
 * Throws when `sets` is empty or repeats a name, a set has no rows or
 * two spans at the same position, or two sets have a field of the same
 * name.
 */
export const alignSets = (
  rows: readonly SpanRow[],
  sets: readonly string[]
): SpanRow[] => {
  checkSetNames(sets);
  const [first, ...others] = sets.map((name) => setRows(rows, name));
  if (!first) return [];
  const owners = new Map<FieldColumn, string>();
  for (const set of [first, ...others]) {
    for (const column of set.fields) {
      const owner = owners.get(column);
      if (owner !== undefined) throw fieldClash(owner, set.name, [column]);
      owners.set(column, set.name);
    }
  }

  const aligned: SpanRow[] = [];
  for (const row of first.rows) {
    const matches = others.map((set) => set.spans.get(spanKey(row)));
    if (!matches.every((match) => match !== undefined)) continue;
    const group = [row, ...matches];
    const merged: SpanRow = {
      ...spanColumns(row),
      score: joinDistinct(group.map((r) => r.score)),
      annotation_set: sets.join("+"),
      unit: joinDistinctUnits(group.map((r) => r.unit)),
    };
    copyColumns(merged, row, first);
    for (const [i, set] of others.entries()) {
      const match = matches[i];
      if (match) copyColumns(merged, match, set);
    }
    aligned.push(merged);
  }
  return renumbered(inTranscriptOrder(aligned));
};

/**
 * The `coarse` set's rows, each with the `fine` set's fields summarised
 * over the fine spans it contains (same sample, message and content part;
 * `fine.start >= coarse.start && fine.end <= coarse.end`), as Python's
 * `roll_up`. Rows keep the coarse set's columns and gain the fine fields'.
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
 * `fields` lacks the options of one of the fine set's categorical fields.
 */
export const rollUp = (
  rows: readonly SpanRow[],
  fine: string,
  coarse: string,
  agg: Aggregation,
  fields: SetFields = {}
): SpanRow[] => {
  if (fine === coarse) {
    throw new Error(`Can't roll annotation set "${fine}" up into itself`);
  }
  const fineSet = setRows(rows, fine);
  const coarseSet = setRows(rows, coarse);
  const clash = fineSet.fields.filter((c) => coarseSet.fields.includes(c));
  if (clash.length > 0) throw fieldClash(fine, coarse, clash);

  const summaries = fineSet.fields.map((column) => {
    if (fineSet.rows.some((row) => typeof row[column] === "number")) {
      return { column, options: undefined };
    }
    const name = fieldName(column);
    const options = fields[fine]?.[name];
    if (!options) {
      throw new Error(
        `The options of field "${name}" of annotation set "${fine}" are not in the fields given`
      );
    }
    return { column, options };
  });

  const fineSpans = new Map<string, SpanRow[]>();
  for (const row of fineSet.rows) {
    const key = partKeyOf(row);
    const spans = fineSpans.get(key);
    if (spans) spans.push(row);
    else fineSpans.set(key, [row]);
  }
  for (const spans of fineSpans.values()) {
    spans.sort((a, b) => a.start - b.start);
  }

  return coarseSet.rows.map((row) => {
    const contained = containedSpans(fineSpans.get(partKeyOf(row)) ?? [], row);
    const rolled: SpanRow = spanColumns(row);
    copyColumns(rolled, row, coarseSet);
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

const checkSetNames = (sets: readonly string[]): void => {
  if (sets.length === 0) throw new Error("No annotation sets given");
  if (new Set(sets).size !== sets.length) {
    throw new Error(`Annotation set names are repeated: ${sets.join(", ")}`);
  }
};

const fieldClash = (
  set: string,
  other: string,
  columns: readonly FieldColumn[]
): Error =>
  new Error(
    `Annotation sets "${set}" and "${other}" both have fields ${columns.map((c) => `"${fieldName(c)}"`).join(", ")}`
  );

interface SetRows {
  name: string;
  rows: SpanRow[];
  /** Rows by `spanKey`. */
  spans: Map<string, SpanRow>;
  /** The field and probability columns the set's rows fill: rows carry
   *  null columns for other sets' fields. */
  fields: FieldColumn[];
  probabilities: ProbabilityColumn[];
}

const setRows = (rows: readonly SpanRow[], name: string): SetRows => {
  const own = rows.filter((row) => row.annotation_set === name);
  if (own.length === 0) {
    const found = [...new Set(rows.map((row) => row.annotation_set))];
    throw new Error(
      `No spans of annotation set "${name}" (found sets ${found.map((s) => `"${s}"`).join(", ")})`
    );
  }
  const spans = new Map<string, SpanRow>();
  const fields = new Set<FieldColumn>();
  const probabilities = new Set<ProbabilityColumn>();
  for (const row of own) {
    const key = spanKey(row);
    if (spans.has(key)) {
      throw new Error(
        `Annotation set "${name}" has more than one span at the same position in a sample: is it in two scores, or is a sample in the rows twice?`
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
  annotation_set,
  unit,
  message_id,
  message_index,
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
  annotation_set,
  unit,
  message_id,
  message_index,
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
  { fields, probabilities }: Pick<SetRows, "fields" | "probabilities">
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
      a.message_index - b.message_index ||
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

/** The units that aren't null, joined as `joinDistinct` does; null when
 *  none of them is (as Python's `align` does). */
const joinDistinctUnits = (units: readonly (string | null)[]): string | null =>
  joinDistinct(units.filter((unit) => unit !== null)) || null;

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
