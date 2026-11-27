import type { EvalSample } from "@tsmono/inspect-common/types";

import {
  spanRows,
  type FieldColumn,
  type FieldOptions,
  type SampleSource,
  type SetFields,
  type SpanRow,
} from "../../chat/annotations/model";

/** An annotation set of a span table: what a view's controls offer for it. */
export interface SetInfo {
  name: string;
  /** What one span is, e.g. "paragraph"; null when the set doesn't say (see
   *  `spanNoun`). */
  unit: string | null;
  /** The scores that hold the set. */
  scores: readonly string[];
  /** Names of its numeric fields, in the set's order. */
  numeric: readonly string[];
  /** Names of its categorical fields, in the set's order. */
  categorical: readonly string[];
}

/**
 * The span table of some samples (see `spanRows`) and what reading it
 * takes, without the samples' messages and events: what analytics keep of
 * a sample once it has loaded.
 */
export interface SpanTable {
  rows: readonly SpanRow[];
  /** The options of the sets' categorical fields. */
  categoricalFields: SetFields;
  sets: readonly SetInfo[];
}

/** One sample's span table, with a message per score or set left out as
 *  invalid. */
export interface SampleSpanTable extends SpanTable {
  errors: readonly string[];
}

/** The span table of `sample`'s annotation sets, without span text. */
export const sampleSpanTable = (
  sample: EvalSample,
  source: SampleSource
): SampleSpanTable => {
  const { rows, categoricalFields, errors } = spanRows(sample, source);
  return {
    rows,
    categoricalFields,
    sets: describeSets(rows, categoricalFields),
    errors,
  };
};

const isFieldColumn = (key: string): key is FieldColumn =>
  key.startsWith("field_");

/** Every row of a set has a value for each of its own fields and null
 *  for other sets' fields, so a set's first row tells its fields. */
const describeSets = (
  rows: readonly SpanRow[],
  categoricalFields: SetFields
): SetInfo[] => {
  const sets = new Map<string, SetInfo>();
  for (const row of rows) {
    const known = sets.get(row.annotation_set);
    if (known) {
      if (!known.scores.includes(row.score)) {
        sets.set(row.annotation_set, {
          ...known,
          scores: [...known.scores, row.score],
        });
      }
      continue;
    }
    const fields = Object.keys(row)
      .filter(isFieldColumn)
      .filter((column) => (row[column] ?? null) !== null)
      .map((column) => column.slice("field_".length));
    const categorical = categoricalFields[row.annotation_set] ?? {};
    sets.set(row.annotation_set, {
      name: row.annotation_set,
      unit: row.unit,
      scores: [row.score],
      numeric: fields.filter((name) => !Object.hasOwn(categorical, name)),
      categorical: fields.filter((name) => Object.hasOwn(categorical, name)),
    });
  }
  return [...sets.values()];
};

/** Several samples' span tables as one, sets in the order first seen. */
export const mergeSpanTables = (tables: readonly SpanTable[]): SpanTable => {
  const sets = new Map<string, SetInfo>();
  const fields: Record<string, Record<string, FieldOptions>> = {};
  for (const table of tables) {
    for (const set of table.sets) {
      const known = sets.get(set.name);
      sets.set(
        set.name,
        known
          ? {
              ...known,
              scores: union(known.scores, set.scores),
              numeric: union(known.numeric, set.numeric),
              categorical: union(known.categorical, set.categorical),
            }
          : set
      );
    }
    for (const [set, byName] of Object.entries(table.categoricalFields)) {
      const merged = (fields[set] ??= {});
      for (const [name, options] of Object.entries(byName)) {
        const known = merged[name];
        merged[name] = known
          ? {
              options: union(known.options, options.options),
              negative: union(known.negative, options.negative),
            }
          : options;
      }
    }
  }
  return {
    rows: tables.flatMap((table) => table.rows),
    categoricalFields: fields,
    sets: [...sets.values()],
  };
};

const union = (
  items: readonly string[],
  more: readonly string[]
): readonly string[] => [...new Set([...items, ...more])];

/** Identifies a sample among rows of one log. */
export const sampleKey = (id: string | number, epoch: number): string =>
  JSON.stringify([String(id), epoch]);

/** Identifies a span's position among rows of one log. */
export const spanKey = (row: SpanRow): string =>
  JSON.stringify([
    row.id,
    row.epoch,
    row.message_id,
    row.content_index,
    row.start,
    row.end,
  ]);

/**
 * The sets whose spans are exactly `x`'s in every sample that has both,
 * `x` included: their fields join `x`'s spans one to one. Other sets'
 * fields reach `x`'s spans only by rolling them up.
 */
export const alignedSets = (
  rows: readonly SpanRow[],
  x: string
): ReadonlySet<string> => {
  const xSpans = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.annotation_set !== x) continue;
    const key = sampleKey(row.id, row.epoch);
    const spans = xSpans.get(key) ?? new Set<string>();
    spans.add(spanKey(row));
    xSpans.set(key, spans);
  }
  const counts = new Map<string, Map<string, number>>();
  const misaligned = new Set<string>();
  for (const row of rows) {
    if (row.annotation_set === x || misaligned.has(row.annotation_set))
      continue;
    const key = sampleKey(row.id, row.epoch);
    const spans = xSpans.get(key);
    if (!spans) continue;
    if (!spans.has(spanKey(row))) {
      misaligned.add(row.annotation_set);
      continue;
    }
    const bySample =
      counts.get(row.annotation_set) ?? new Map<string, number>();
    bySample.set(key, (bySample.get(key) ?? 0) + 1);
    counts.set(row.annotation_set, bySample);
  }
  const aligned = new Set<string>(xSpans.size > 0 ? [x] : []);
  for (const [set, bySample] of counts) {
    if (misaligned.has(set)) continue;
    const covers = [...bySample].every(
      ([key, count]) => count === xSpans.get(key)?.size
    );
    if (covers) aligned.add(set);
  }
  return aligned;
};
