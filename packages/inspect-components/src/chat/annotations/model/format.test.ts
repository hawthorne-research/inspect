import { describe, expect, it } from "vitest";

import { parseTextAnnotations, type AnnotationSet } from "./format";
import {
  findingField,
  kindField,
  probeField,
  rawAnnotations,
  rawPart,
  rawSet,
  suspectsField,
} from "./testFixtures";

const parsedSet = (raw: unknown): AnnotationSet => {
  const result = parseTextAnnotations(rawAnnotations([raw]));
  if (!result.ok) throw new Error(result.error);
  const [set] = result.value;
  if (!set?.ok) throw new Error(set?.error ?? "no set");
  return set.value;
};

const setError = (raw: unknown): string | undefined => {
  const result = parseTextAnnotations(rawAnnotations([raw]));
  if (!result.ok) return result.error;
  const [set] = result.value;
  return set && !set.ok ? set.error : undefined;
};

const labelSet = (part: Record<string, unknown> = {}) =>
  rawSet({
    name: "paragraph labels",
    unit: "paragraph",
    metadata: undefined,
    fields: [kindField, suspectsField],
    parts: [
      rawPart({
        message_id: "a1",
        content_index: 0,
        starts: [0],
        ends: [21],
        values: { kind: ["mapping"], suspects_test: ["no"] },
        probabilities: {
          kind: [[0.1, 0.9]],
          suspects_test: [[0.2, 0.8]],
        },
        ...part,
      }),
    ],
  });

describe("parseTextAnnotations", () => {
  it("accepts a numeric set", () => {
    const set = parsedSet(rawSet());
    expect(set.fields).toEqual([
      {
        type: "numeric",
        name: "deception",
        description: "Linear probe",
        metadata: { layer: 12, method: "logistic regression" },
      },
    ]);
    expect(set.parts[0]?.values.get("deception")).toEqual([0.5, -1, 2]);
  });

  it("accepts a categorical set with probabilities", () => {
    const set = parsedSet(labelSet());
    const [part] = set.parts;
    expect(part?.labels.get("kind")).toEqual(["mapping"]);
    expect(part?.probabilities.get("suspects_test")).toEqual([[0.2, 0.8]]);
  });

  it("keeps a categorical field's negative options", () => {
    const [, suspects] = parsedSet(labelSet()).fields;
    expect(suspects).toEqual({
      type: "categorical",
      name: "suspects_test",
      description: null,
      metadata: {},
      options: ["yes", "no"],
      negative: ["no"],
    });
  });

  it("accepts a set with both a categorical and a numeric field", () => {
    const set = parsedSet(
      rawSet({
        fields: [kindField, probeField],
        parts: [
          rawPart({
            values: {
              kind: ["mapping", "task_work", "mapping"],
              deception: [1, 2, 3],
            },
          }),
        ],
      })
    );
    const [part] = set.parts;
    expect(part?.labels.get("kind")).toHaveLength(3);
    expect(part?.values.get("deception")).toEqual([1, 2, 3]);
  });

  it("accepts spans with gaps between them, spans that touch, and no parts", () => {
    expect(setError(rawSet())).toBeUndefined();
    expect(
      setError(
        rawSet({
          parts: [
            rawPart({
              starts: [0, 5],
              ends: [5, 9],
              values: { deception: [1, 2] },
            }),
          ],
        })
      )
    ).toBeUndefined();
    expect(setError(rawSet({ parts: [] }))).toBeUndefined();
  });

  it("reads a missing or null unit as null, and keeps a given one", () => {
    expect(parsedSet(rawSet({ unit: undefined })).unit).toBeNull();
    expect(parsedSet(rawSet({ unit: null })).unit).toBeNull();
    expect(parsedSet(rawSet()).unit).toBe("token");
  });

  it("fills a missing description, metadata and negative options", () => {
    const set = parsedSet(
      rawSet({
        description: undefined,
        fields: [
          { name: "p", type: "numeric" },
          { name: "c", type: "categorical", options: ["a", "b"] },
        ],
        parts: [],
      })
    );
    expect(set.description).toBeNull();
    expect(set.fields).toEqual([
      { type: "numeric", name: "p", description: null, metadata: {} },
      {
        type: "categorical",
        name: "c",
        description: null,
        metadata: {},
        options: ["a", "b"],
        negative: [],
      },
    ]);
  });

  it("keeps a set's and a field's metadata, of any JSON values", () => {
    const metadata = {
      tokenizer: "tiktoken/o200k_base",
      threshold: 0.5,
      layers: [16, 24],
      run: { seed: 1, tags: null },
    };
    const set = parsedSet(
      rawSet({ metadata, fields: [{ ...probeField, metadata }] })
    );
    expect(set.metadata).toEqual(metadata);
    expect(set.fields[0]?.metadata).toEqual(metadata);
  });

  it("reads missing metadata as empty", () => {
    expect(parsedSet(labelSet()).metadata).toEqual({});
  });

  it.each([
    ["null", null],
    ["a list", ["tiktoken/o200k_base"]],
    ["a string", "tiktoken/o200k_base"],
  ])("rejects metadata that is %s", (_name, metadata) => {
    expect(setError(rawSet({ metadata }))).toBe(
      'set "probes": metadata is not an object'
    );
    expect(setError(rawSet({ fields: [{ ...probeField, metadata }] }))).toBe(
      'set "probes": fields[0]: metadata is not an object'
    );
  });

  const negative = (options: unknown) =>
    rawSet({ fields: [{ ...findingField, negative: options }], parts: [] });

  it.each([
    ["null", null, "negative is not a list of strings"],
    ["a string", "absent", "negative is not a list of strings"],
    ["not an option", ["missing"], "negative option missing is not an option"],
    ["repeated", ["absent", "absent"], "negative has repeats"],
    ["every option", ["absent", "present"], "every option is negative"],
  ])("rejects negative options that are %s", (_name, options, error) => {
    expect(setError(negative(options))).toBe(
      `set "probes": fields[0]: ${error}`
    );
  });

  it.each([
    ["a non-object", "nope"],
    ["version 0", { ...rawAnnotations(), version: 0 }],
    ["version 1", { ...rawAnnotations(), version: 1 }],
    ["an unknown version", { ...rawAnnotations(), version: 3 }],
    ["sets that are not a list", { version: 2, sets: {} }],
    ["layers in place of sets", { version: 2, layers: [rawSet()] }],
  ])("rejects %s as a whole", (_name, raw) => {
    expect(parseTextAnnotations(raw).ok).toBe(false);
  });

  it("names the version it reads when rejecting another", () => {
    expect(parseTextAnnotations({ ...rawAnnotations(), version: 1 })).toEqual({
      ok: false,
      error: "unsupported version 1 (this viewer reads version 2)",
    });
  });

  const values = (deception: unknown) => rawPart({ values: { deception } });

  it.each([
    ["a non-object set", "nope"],
    ["an unnamed set", rawSet({ name: "" })],
    ["an empty unit", rawSet({ unit: "" })],
    ["a non-string unit", rawSet({ unit: 3 })],
    ["a non-string source", rawSet({ source: 3 })],
    ["no fields", rawSet({ fields: [] })],
    ["an unnamed field", rawSet({ fields: [{ name: "", type: "numeric" }] })],
    [
      "an unknown field type",
      rawSet({ fields: [{ name: "p", type: "text" }] }),
    ],
    ["a duplicate field name", rawSet({ fields: [probeField, probeField] })],
    [
      "a categorical field with one option",
      rawSet({ fields: [{ ...kindField, options: ["a"] }], parts: [] }),
    ],
    [
      "a categorical field with repeated options",
      rawSet({ fields: [{ ...kindField, options: ["a", "a"] }], parts: [] }),
    ],
    [
      "a part without a message id",
      rawSet({ parts: [rawPart({ message_id: "" })] }),
    ],
    [
      "a missing content index",
      rawSet({ parts: [rawPart({ content_index: undefined })] }),
    ],
    [
      "a negative content index",
      rawSet({ parts: [rawPart({ content_index: -1 })] }),
    ],
    ["unequal starts and ends", rawSet({ parts: [rawPart({ ends: [5, 9] })] })],
    ["a negative start", rawSet({ parts: [rawPart({ starts: [-1, 6, 10] })] })],
    [
      "a fractional offset",
      rawSet({ parts: [rawPart({ ends: [5, 9.5, 15] })] }),
    ],
    ["an empty span", rawSet({ parts: [rawPart({ starts: [0, 6, 15] })] })],
    ["overlapping spans", rawSet({ parts: [rawPart({ starts: [0, 4, 10] })] })],
    ["a missing field's values", rawSet({ parts: [rawPart({ values: {} })] })],
    [
      "values for an unknown field",
      rawSet({
        parts: [
          rawPart({ values: { deception: [0, 0, 0], other: [0, 0, 0] } }),
        ],
      }),
    ],
    ["too few values", rawSet({ parts: [values([1, 2])] })],
    ["a non-finite value", rawSet({ parts: [values([1, Number.NaN, 2])] })],
    ["a non-numeric value", rawSet({ parts: [values([1, "2", 3])] })],
    [
      "two parts for one content part",
      rawSet({ parts: [rawPart(), rawPart()] }),
    ],
    [
      "a label outside its options",
      labelSet({ values: { kind: ["x"], suspects_test: ["no"] } }),
    ],
    [
      "a numeric label",
      labelSet({ values: { kind: [1], suspects_test: ["no"] } }),
    ],
    [
      "probabilities for a numeric field",
      rawSet({
        parts: [rawPart({ probabilities: { deception: [[1], [1], [1]] } })],
      }),
    ],
    [
      "probabilities for an unknown field",
      labelSet({ probabilities: { mood: [[0.5, 0.5]] } }),
    ],
    [
      "probabilities without one entry per span",
      labelSet({ probabilities: { kind: [] } }),
    ],
    [
      "probabilities without one per option",
      labelSet({ probabilities: { kind: [[1]] } }),
    ],
    [
      "a probability outside [0, 1]",
      labelSet({ probabilities: { kind: [[1.5, 0]] } }),
    ],
  ])("rejects %s", (_name, raw) => {
    expect(setError(raw)).toBeDefined();
  });

  it("rejects a set named twice in one score, keeping the first", () => {
    const result = parseTextAnnotations(rawAnnotations([rawSet(), rawSet()]));
    expect(result.ok && result.value.map((set) => set.ok)).toEqual([
      true,
      false,
    ]);
  });

  it("rejects a repeated set name even when the first is invalid", () => {
    const result = parseTextAnnotations(
      rawAnnotations([rawSet({ unit: 3 }), rawSet()])
    );
    expect(result.ok && result.value.map((set) => set.ok)).toEqual([
      false,
      false,
    ]);
  });

  it("validates each set on its own", () => {
    const result = parseTextAnnotations(
      rawAnnotations([rawSet({ name: "bad", unit: 3 }), labelSet()])
    );
    expect(result.ok && result.value.map((set) => set.ok)).toEqual([
      false,
      true,
    ]);
  });
});
