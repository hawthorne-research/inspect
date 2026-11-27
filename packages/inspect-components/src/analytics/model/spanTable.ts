import type { EvalSample } from "@tsmono/inspect-common/types";

import {
  spanRows,
  type FieldColumn,
  type FieldOptions,
  type LayerFields,
  type SampleSource,
  type SpanRow,
} from "../../chat/annotations/model";

/** A layer of a span table: what a view's controls offer for it. */
export interface LayerInfo {
  name: string;
  /** What one span is, e.g. "paragraph". */
  unit: string;
  /** The scores that hold the layer. */
  scores: readonly string[];
  /** Names of its numeric fields, in the layer's order. */
  numeric: readonly string[];
  /** Names of its categorical fields, in the layer's order. */
  categorical: readonly string[];
}

/**
 * The span table of some samples (see `spanRows`) and what reading it
 * takes, without the samples' messages and events: what analytics keep of
 * a sample once it has loaded.
 */
export interface SpanTable {
  rows: readonly SpanRow[];
  /** The options of the layers' categorical fields. */
  categoricalFields: LayerFields;
  layers: readonly LayerInfo[];
}

/** One sample's span table, with a message per score or layer left out as
 *  invalid. */
export interface SampleSpanTable extends SpanTable {
  errors: readonly string[];
}

/** The span table of `sample`'s annotation layers, without span text. */
export const sampleSpanTable = (
  sample: EvalSample,
  source: SampleSource
): SampleSpanTable => {
  const { rows, categoricalFields, errors } = spanRows(sample, source);
  return {
    rows,
    categoricalFields,
    layers: describeLayers(rows, categoricalFields),
    errors,
  };
};

const isFieldColumn = (key: string): key is FieldColumn =>
  key.startsWith("field_");

/** Every row of a layer has a value for each of its own fields and null
 *  for other layers' fields, so a layer's first row tells its fields. */
const describeLayers = (
  rows: readonly SpanRow[],
  categoricalFields: LayerFields
): LayerInfo[] => {
  const layers = new Map<string, LayerInfo>();
  for (const row of rows) {
    const known = layers.get(row.layer);
    if (known) {
      if (!known.scores.includes(row.score)) {
        layers.set(row.layer, {
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
    const categorical = categoricalFields[row.layer] ?? {};
    layers.set(row.layer, {
      name: row.layer,
      unit: row.unit,
      scores: [row.score],
      numeric: fields.filter((name) => !Object.hasOwn(categorical, name)),
      categorical: fields.filter((name) => Object.hasOwn(categorical, name)),
    });
  }
  return [...layers.values()];
};

/** Several samples' span tables as one, layers in the order first seen. */
export const mergeSpanTables = (tables: readonly SpanTable[]): SpanTable => {
  const layers = new Map<string, LayerInfo>();
  const fields: Record<string, Record<string, FieldOptions>> = {};
  for (const table of tables) {
    for (const layer of table.layers) {
      const known = layers.get(layer.name);
      layers.set(
        layer.name,
        known
          ? {
              ...known,
              scores: union(known.scores, layer.scores),
              numeric: union(known.numeric, layer.numeric),
              categorical: union(known.categorical, layer.categorical),
            }
          : layer
      );
    }
    for (const [layer, byName] of Object.entries(table.categoricalFields)) {
      const merged = (fields[layer] ??= {});
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
    layers: [...layers.values()],
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
 * The layers whose spans are exactly `x`'s in every sample that has both,
 * `x` included: their fields join `x`'s spans one to one. Other layers'
 * fields reach `x`'s spans only by rolling them up.
 */
export const alignedLayers = (
  rows: readonly SpanRow[],
  x: string
): ReadonlySet<string> => {
  const xSpans = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.layer !== x) continue;
    const key = sampleKey(row.id, row.epoch);
    const spans = xSpans.get(key) ?? new Set<string>();
    spans.add(spanKey(row));
    xSpans.set(key, spans);
  }
  const counts = new Map<string, Map<string, number>>();
  const misaligned = new Set<string>();
  for (const row of rows) {
    if (row.layer === x || misaligned.has(row.layer)) continue;
    const key = sampleKey(row.id, row.epoch);
    const spans = xSpans.get(key);
    if (!spans) continue;
    if (!spans.has(spanKey(row))) {
      misaligned.add(row.layer);
      continue;
    }
    const bySample = counts.get(row.layer) ?? new Map<string, number>();
    bySample.set(key, (bySample.get(key) ?? 0) + 1);
    counts.set(row.layer, bySample);
  }
  const aligned = new Set<string>(xSpans.size > 0 ? [x] : []);
  for (const [layer, bySample] of counts) {
    if (misaligned.has(layer)) continue;
    const covers = [...bySample].every(
      ([key, count]) => count === xSpans.get(key)?.size
    );
    if (covers) aligned.add(layer);
  }
  return aligned;
};
