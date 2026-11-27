import { getOwn, isRecord } from "@tsmono/util";

/** Score metadata key that carries annotations of transcript text. */
export const kTextAnnotationsKey = "text_annotations";

/** The one version of the format this module reads. */
export const kFormatVersion = 1;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** JSON values by key, e.g. `{ tokenizer: "tiktoken/o200k_base" }`: how
 *  a layer or field was made, shown as it is. */
export type AnnotationMetadata = Readonly<Record<string, unknown>>;

interface FieldBase {
  name: string;
  description: string | null;
  metadata: AnnotationMetadata;
}

export interface CategoricalField extends FieldBase {
  type: "categorical";
  options: readonly string[];
  /** Options that mean "nothing found", e.g. the "no" of a yes/no field;
   *  never every option. */
  negative: readonly string[];
}

export interface NumericField extends FieldBase {
  type: "numeric";
}

export type AnnotationField = CategoricalField | NumericField;

/** The spans of one content part's text, as stored: `starts`/`ends` are
 *  Unicode code-point offsets (Python `str` indices), end exclusive. */
export interface AnnotationPart {
  messageId: string;
  /** Null when the message's content is a plain string. */
  contentIndex: number | null;
  starts: readonly number[];
  ends: readonly number[];
  /** Per categorical field, one option per span. */
  labels: ReadonlyMap<string, readonly string[]>;
  /** Per numeric field, one value per span. */
  values: ReadonlyMap<string, readonly number[]>;
  /** Per categorical field that has them, one distribution per span over
   *  the field's options, in options order. */
  probabilities: ReadonlyMap<string, readonly (readonly number[])[]>;
}

/** One set of fields over spans of transcript text, e.g. a classifier's
 *  paragraph labels or a set of probes' per-token values. */
export interface AnnotationLayer {
  name: string;
  /** What one span is, for display only, e.g. "paragraph" or "token". */
  unit: string;
  /** What produced the values. */
  source: string;
  metadata: AnnotationMetadata;
  description: string | null;
  fields: readonly AnnotationField[];
  parts: readonly AnnotationPart[];
}

/**
 * Validates a `text_annotations` value. The outer result fails when the
 * value as a whole is unusable; otherwise each layer is validated on its
 * own, so one bad layer leaves the others usable.
 */
export const parseTextAnnotations = (
  raw: unknown
): Parsed<Parsed<AnnotationLayer>[]> => {
  if (!isRecord(raw)) return fail(`${kTextAnnotationsKey} is not an object`);
  if (raw["version"] !== kFormatVersion) {
    return fail(`unsupported version ${String(raw["version"])}`);
  }
  const rawLayers = raw["layers"];
  if (!Array.isArray(rawLayers)) return fail("layers is not an array");

  const names = new Set<string>();
  const layers = rawLayers.map(
    (rawLayer: unknown, i): Parsed<AnnotationLayer> => {
      const name = isRecord(rawLayer) ? rawLayer["name"] : undefined;
      const label =
        typeof name === "string" ? `layer "${name}"` : `layers[${i}]`;
      if (typeof name === "string") {
        if (names.has(name)) return fail(`${label} is defined twice`);
        names.add(name);
      }
      const layer = parseLayer(rawLayer);
      return layer.ok ? layer : fail(`${label}: ${layer.error}`);
    }
  );
  return { ok: true, value: layers };
};

const parseLayer = (raw: unknown): Parsed<AnnotationLayer> => {
  if (!isRecord(raw)) return fail("not an object");
  const name = raw["name"];
  const unit = raw["unit"];
  const source = raw["source"];
  const metadata = orDefault(raw["metadata"], {});
  const description = raw["description"] ?? null;
  if (typeof name !== "string" || !name) {
    return fail("name is not a non-empty string");
  }
  if (typeof unit !== "string" || !unit) {
    return fail("unit is not a non-empty string");
  }
  if (typeof source !== "string") return fail("source is not a string");
  if (!isRecord(metadata)) return fail("metadata is not an object");
  if (description !== null && typeof description !== "string") {
    return fail("description is not a string");
  }

  const fields = parseFields(raw["fields"]);
  if (!fields.ok) return fields;

  const rawParts = raw["parts"];
  if (!Array.isArray(rawParts)) return fail("parts is not an array");
  const parts: AnnotationPart[] = [];
  const seen = new Set<string>();
  for (const [i, rawPart] of rawParts.entries()) {
    const part = parsePart(rawPart, fields.value);
    if (!part.ok) return fail(`parts[${i}]: ${part.error}`);
    const key = partKey(part.value.messageId, part.value.contentIndex);
    if (seen.has(key)) return fail(`parts[${i}]: ${key} is annotated twice`);
    seen.add(key);
    parts.push(part.value);
  }

  return {
    ok: true,
    value: {
      name,
      unit,
      source,
      metadata,
      description,
      fields: fields.value,
      parts,
    },
  };
};

const parseFields = (raw: unknown): Parsed<AnnotationField[]> => {
  if (!Array.isArray(raw) || raw.length === 0) {
    return fail("fields is not a non-empty array");
  }
  const fields: AnnotationField[] = [];
  for (const [i, rawField] of raw.entries()) {
    const field = parseField(rawField);
    if (!field.ok) return fail(`fields[${i}]: ${field.error}`);
    if (fields.some((other) => other.name === field.value.name)) {
      return fail(`field ${field.value.name} is defined twice`);
    }
    fields.push(field.value);
  }
  return { ok: true, value: fields };
};

const parseField = (raw: unknown): Parsed<AnnotationField> => {
  if (!isRecord(raw)) return fail("not an object");
  const name = raw["name"];
  const description = raw["description"] ?? null;
  const metadata = orDefault(raw["metadata"], {});
  if (typeof name !== "string" || !name) {
    return fail("name is not a non-empty string");
  }
  if (description !== null && typeof description !== "string") {
    return fail("description is not a string");
  }
  if (!isRecord(metadata)) return fail("metadata is not an object");
  const type = raw["type"];
  if (type === "categorical") {
    const options = raw["options"];
    if (!isStringArray(options))
      return fail("options is not a list of strings");
    if (new Set(options).size !== options.length) {
      return fail("options are not unique");
    }
    if (options.length < 2) return fail("fewer than two options");
    const negative = parseNegative(orDefault(raw["negative"], []), options);
    if (!negative.ok) return negative;
    return {
      ok: true,
      value: {
        type,
        name,
        description,
        metadata,
        options,
        negative: negative.value,
      },
    };
  }
  if (type === "numeric") {
    return { ok: true, value: { type, name, description, metadata } };
  }
  return fail(`unknown type ${String(type)}`);
};

const parseNegative = (
  raw: unknown,
  options: readonly string[]
): Parsed<string[]> => {
  if (!isStringArray(raw)) return fail("negative is not a list of strings");
  const unknown = raw.find((option) => !options.includes(option));
  if (unknown !== undefined) {
    return fail(`negative option ${unknown} is not an option`);
  }
  if (new Set(raw).size !== raw.length) return fail("negative has repeats");
  if (raw.length === options.length) {
    return fail("every option is negative");
  }
  return { ok: true, value: raw };
};

const parsePart = (
  raw: unknown,
  fields: readonly AnnotationField[]
): Parsed<AnnotationPart> => {
  if (!isRecord(raw)) return fail("not an object");
  const messageId = raw["message_id"];
  const contentIndex = raw["content_index"];
  const starts = raw["starts"];
  const ends = raw["ends"];
  if (typeof messageId !== "string" || !messageId) {
    return fail("message_id is not a non-empty string");
  }
  if (contentIndex !== null && !isNonNegativeInt(contentIndex)) {
    return fail("content_index is not null or a non-negative integer");
  }
  if (!isOffsetArray(starts) || !isOffsetArray(ends)) {
    return fail("starts and ends are not arrays of non-negative integers");
  }
  if (starts.length !== ends.length) {
    return fail(`${starts.length} starts but ${ends.length} ends`);
  }
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i] ?? 0;
    const end = ends[i] ?? 0;
    if (start >= end) return fail(`span ${i} is empty: [${start}, ${end})`);
    const prevEnd = i > 0 ? (ends[i - 1] ?? 0) : 0;
    if (start < prevEnd) {
      return fail(`span ${i} starts at ${start}, before the previous end`);
    }
  }

  const rawValues = raw["values"];
  if (!isRecord(rawValues)) return fail("values is not an object");
  const unknown = Object.keys(rawValues).find(
    (name) => !fields.some((f) => f.name === name)
  );
  if (unknown !== undefined) return fail(`values for unknown field ${unknown}`);
  const labels = new Map<string, readonly string[]>();
  const values = new Map<string, readonly number[]>();
  for (const field of fields) {
    const series = getOwn(rawValues, field.name);
    if (!Array.isArray(series) || series.length !== starts.length) {
      return fail(`values.${field.name} does not have one value per span`);
    }
    if (field.type === "categorical") {
      const options = field.options;
      if (!isStringArray(series) || !series.every((v) => options.includes(v))) {
        return fail(`values.${field.name} has a value that is not an option`);
      }
      labels.set(field.name, series);
    } else {
      if (!series.every(isFiniteNumber)) {
        return fail(
          `values.${field.name} has a value that is not a finite number`
        );
      }
      values.set(field.name, series);
    }
  }

  const probabilities = parseProbabilities(
    raw["probabilities"],
    fields,
    starts.length
  );
  if (!probabilities.ok) return probabilities;

  return {
    ok: true,
    value: {
      messageId,
      contentIndex,
      starts,
      ends,
      labels,
      values,
      probabilities: probabilities.value,
    },
  };
};

const parseProbabilities = (
  raw: unknown,
  fields: readonly AnnotationField[],
  spanCount: number
): Parsed<Map<string, readonly (readonly number[])[]>> => {
  const probabilities = new Map<string, readonly (readonly number[])[]>();
  if (raw === undefined || raw === null)
    return { ok: true, value: probabilities };
  if (!isRecord(raw)) return fail("probabilities is not an object");
  for (const [name, rawSeries] of Object.entries(raw)) {
    const field = fields.find((f) => f.name === name);
    if (field?.type !== "categorical") {
      return fail(
        `probabilities for ${name}, which is not a categorical field`
      );
    }
    if (!Array.isArray(rawSeries) || rawSeries.length !== spanCount) {
      return fail(`probabilities.${name} does not have one entry per span`);
    }
    const series: number[][] = [];
    for (const [i, entry] of rawSeries.entries()) {
      if (
        !Array.isArray(entry) ||
        entry.length !== field.options.length ||
        !entry.every(isProbability)
      ) {
        return fail(
          `probabilities.${name}[${i}] is not one probability per option`
        );
      }
      series.push(entry);
    }
    probabilities.set(name, series);
  }
  return { ok: true, value: probabilities };
};

/** Identifies a content part of a message. */
export const partKey = (
  messageId: string,
  contentIndex: number | null
): string => `${messageId}[${contentIndex ?? "content"}]`;

/** `value`, or `fallback` when the key is missing; null is not missing. */
const orDefault = (value: unknown, fallback: unknown): unknown =>
  value === undefined ? fallback : value;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isProbability = (value: unknown): value is number =>
  isFiniteNumber(value) && value >= 0 && value <= 1;

const isNonNegativeInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isOffsetArray = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every(isNonNegativeInt);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === "string");

export const fail = (error: string): { ok: false; error: string } => ({
  ok: false,
  error,
});
