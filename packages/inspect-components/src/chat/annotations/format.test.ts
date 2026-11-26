import { describe, expect, it } from "vitest";

import { parseTextAnnotations, type AnnotationLayer } from "./format";
import {
  kindField,
  probeField,
  rawAnnotations,
  rawLayer,
  rawPart,
  suspectsField,
} from "./testFixtures";

const parsedLayer = (raw: unknown): AnnotationLayer => {
  const result = parseTextAnnotations(rawAnnotations([raw]));
  if (!result.ok) throw new Error(result.error);
  const [layer] = result.value;
  if (!layer?.ok) throw new Error(layer?.error ?? "no layer");
  return layer.value;
};

const layerError = (raw: unknown): string | undefined => {
  const result = parseTextAnnotations(rawAnnotations([raw]));
  if (!result.ok) return result.error;
  const [layer] = result.value;
  return layer && !layer.ok ? layer.error : undefined;
};

const labelLayer = (part: Record<string, unknown> = {}) =>
  rawLayer({
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
  it("accepts a numeric layer", () => {
    const layer = parsedLayer(rawLayer());
    expect(layer.fields).toEqual([
      {
        type: "numeric",
        name: "deception",
        description: "Linear probe",
        modelLayer: 12,
      },
    ]);
    expect(layer.parts[0]?.values.get("deception")).toEqual([0.5, -1, 2]);
  });

  it("accepts a categorical layer with probabilities", () => {
    const layer = parsedLayer(labelLayer());
    const [part] = layer.parts;
    expect(part?.labels.get("kind")).toEqual(["mapping"]);
    expect(part?.probabilities.get("suspects_test")).toEqual([[0.2, 0.8]]);
  });

  it("accepts a layer with both a categorical and a numeric field", () => {
    const layer = parsedLayer(
      rawLayer({
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
    const [part] = layer.parts;
    expect(part?.labels.get("kind")).toHaveLength(3);
    expect(part?.values.get("deception")).toEqual([1, 2, 3]);
  });

  it("accepts spans with gaps between them, spans that touch, and no parts", () => {
    expect(layerError(rawLayer())).toBeUndefined();
    expect(
      layerError(
        rawLayer({
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
    expect(layerError(rawLayer({ parts: [] }))).toBeUndefined();
  });

  it("fills a missing description and model layer with null", () => {
    const layer = parsedLayer(
      rawLayer({
        description: undefined,
        fields: [{ name: "p", type: "numeric" }],
        parts: [],
      })
    );
    expect(layer.description).toBeNull();
    expect(layer.fields).toEqual([
      { type: "numeric", name: "p", description: null, modelLayer: null },
    ]);
  });

  it("keeps a layer's metadata, of any JSON values", () => {
    const metadata = {
      tokenizer: "tiktoken/o200k_base",
      threshold: 0.5,
      layers: [16, 24],
      run: { seed: 1, tags: null },
    };
    expect(parsedLayer(rawLayer({ metadata })).metadata).toEqual(metadata);
  });

  it("reads missing metadata as empty", () => {
    expect(parsedLayer(labelLayer()).metadata).toEqual({});
  });

  it.each([
    ["null", null],
    ["a list", ["tiktoken/o200k_base"]],
    ["a string", "tiktoken/o200k_base"],
  ])("rejects metadata that is %s", (_name, metadata) => {
    expect(layerError(rawLayer({ metadata }))).toBe(
      'layer "probes": metadata is not an object'
    );
  });

  it.each([
    ["a non-object", "nope"],
    ["an unknown version", { ...rawAnnotations(), version: 1 }],
    ["layers that are not a list", { version: 0, layers: {} }],
  ])("rejects %s as a whole", (_name, raw) => {
    expect(parseTextAnnotations(raw).ok).toBe(false);
  });

  const values = (deception: unknown) => rawPart({ values: { deception } });

  it.each([
    ["a non-object layer", "nope"],
    ["an unnamed layer", rawLayer({ name: "" })],
    ["a missing unit", rawLayer({ unit: undefined })],
    ["a non-string source", rawLayer({ source: 3 })],
    ["no fields", rawLayer({ fields: [] })],
    ["an unnamed field", rawLayer({ fields: [{ name: "", type: "numeric" }] })],
    [
      "an unknown field type",
      rawLayer({ fields: [{ name: "p", type: "text" }] }),
    ],
    ["a duplicate field name", rawLayer({ fields: [probeField, probeField] })],
    [
      "a non-numeric model layer",
      rawLayer({ fields: [{ ...probeField, model_layer: "x" }] }),
    ],
    [
      "a categorical field with one option",
      rawLayer({ fields: [{ ...kindField, options: ["a"] }], parts: [] }),
    ],
    [
      "a categorical field with repeated options",
      rawLayer({ fields: [{ ...kindField, options: ["a", "a"] }], parts: [] }),
    ],
    [
      "a part without a message id",
      rawLayer({ parts: [rawPart({ message_id: "" })] }),
    ],
    [
      "a missing content index",
      rawLayer({ parts: [rawPart({ content_index: undefined })] }),
    ],
    [
      "a negative content index",
      rawLayer({ parts: [rawPart({ content_index: -1 })] }),
    ],
    [
      "unequal starts and ends",
      rawLayer({ parts: [rawPart({ ends: [5, 9] })] }),
    ],
    [
      "a negative start",
      rawLayer({ parts: [rawPart({ starts: [-1, 6, 10] })] }),
    ],
    [
      "a fractional offset",
      rawLayer({ parts: [rawPart({ ends: [5, 9.5, 15] })] }),
    ],
    ["an empty span", rawLayer({ parts: [rawPart({ starts: [0, 6, 15] })] })],
    [
      "overlapping spans",
      rawLayer({ parts: [rawPart({ starts: [0, 4, 10] })] }),
    ],
    [
      "a missing field's values",
      rawLayer({ parts: [rawPart({ values: {} })] }),
    ],
    [
      "values for an unknown field",
      rawLayer({
        parts: [
          rawPart({ values: { deception: [0, 0, 0], other: [0, 0, 0] } }),
        ],
      }),
    ],
    ["too few values", rawLayer({ parts: [values([1, 2])] })],
    ["a non-finite value", rawLayer({ parts: [values([1, Number.NaN, 2])] })],
    ["a non-numeric value", rawLayer({ parts: [values([1, "2", 3])] })],
    [
      "two parts for one content part",
      rawLayer({ parts: [rawPart(), rawPart()] }),
    ],
    [
      "a label outside its options",
      labelLayer({ values: { kind: ["x"], suspects_test: ["no"] } }),
    ],
    [
      "a numeric label",
      labelLayer({ values: { kind: [1], suspects_test: ["no"] } }),
    ],
    [
      "probabilities for a numeric field",
      rawLayer({
        parts: [rawPart({ probabilities: { deception: [[1], [1], [1]] } })],
      }),
    ],
    [
      "probabilities for an unknown field",
      labelLayer({ probabilities: { mood: [[0.5, 0.5]] } }),
    ],
    [
      "probabilities without one entry per span",
      labelLayer({ probabilities: { kind: [] } }),
    ],
    [
      "probabilities without one per option",
      labelLayer({ probabilities: { kind: [[1]] } }),
    ],
    [
      "a probability outside [0, 1]",
      labelLayer({ probabilities: { kind: [[1.5, 0]] } }),
    ],
  ])("rejects %s", (_name, raw) => {
    expect(layerError(raw)).toBeDefined();
  });

  it("rejects a layer named twice in one score, keeping the first", () => {
    const result = parseTextAnnotations(
      rawAnnotations([rawLayer(), rawLayer()])
    );
    expect(result.ok && result.value.map((layer) => layer.ok)).toEqual([
      true,
      false,
    ]);
  });

  it("rejects a repeated layer name even when the first is invalid", () => {
    const result = parseTextAnnotations(
      rawAnnotations([rawLayer({ unit: 3 }), rawLayer()])
    );
    expect(result.ok && result.value.map((layer) => layer.ok)).toEqual([
      false,
      false,
    ]);
  });

  it("validates each layer on its own", () => {
    const result = parseTextAnnotations(
      rawAnnotations([rawLayer({ name: "bad", unit: 3 }), labelLayer()])
    );
    expect(result.ok && result.value.map((layer) => layer.ok)).toEqual([
      false,
      true,
    ]);
  });
});
