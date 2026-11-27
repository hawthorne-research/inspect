import { describe, expect, it } from "vitest";

import {
  testAssistantMessage,
  testScore,
  testSystemMessage,
  testToolMessage,
  testUserMessage,
} from "@tsmono/inspect-common/testing";
import type {
  ChatMessage,
  ContentReasoning,
  ContentText,
} from "@tsmono/inspect-common/types";

import {
  codePointOffsets,
  collectAnnotationLayers,
  spanText,
  type ResolvedPart,
} from "./layers";
import {
  annotatedScore,
  kindField,
  rawLayer,
  rawPart,
  resolvedLayer,
} from "./testFixtures";

const reasoning = (text: string): ContentReasoning => ({
  type: "reasoning",
  reasoning: text,
  redacted: false,
});

const textPart = (text: string): ContentText => ({
  type: "text",
  text,
  refusal: null,
  internal: null,
  citations: null,
});

const kMessages: ChatMessage[] = [
  testSystemMessage({ id: "s1", content: "Be brief." }),
  testUserMessage({ id: "u1", content: "Solve the maze." }),
  testAssistantMessage({
    id: "a1",
    content: [reasoning("Map it first."), textPart("Done.")],
  }),
  testToolMessage({ id: "t1", content: "ok" }),
];

const kParagraphs = "First I map the maze.\n\nThen I solve it.";

const labelLayer = (overrides: Record<string, unknown> = {}) =>
  rawLayer({
    name: "paragraph labels",
    unit: "paragraph",
    fields: [kindField],
    parts: [
      rawPart({
        message_id: "p1",
        content_index: 0,
        starts: [0, 23],
        ends: [21, 39],
        values: { kind: ["mapping", "task_work"] },
      }),
    ],
    ...overrides,
  });

const kParagraphMessages: ChatMessage[] = [
  testAssistantMessage({ id: "p1", content: [reasoning(kParagraphs)] }),
];

const spans = (part: ResolvedPart | undefined): string[] =>
  part ? part.starts.map((_, i) => spanText(part, i)) : [];

const errorOf = (layer: unknown, messages: ChatMessage[] = kMessages) =>
  collectAnnotationLayers({ probes: annotatedScore([layer]) }, messages)
    .errors[0];

describe("collectAnnotationLayers", () => {
  it("collects layers from every score, in score order", () => {
    const { layers, errors } = collectAnnotationLayers(
      {
        accuracy: testScore({ value: 1 }),
        paragraphs: annotatedScore([labelLayer()]),
        tokens: annotatedScore([
          rawLayer(),
          rawLayer({ name: "more probes", parts: [] }),
        ]),
      },
      [...kMessages, ...kParagraphMessages]
    );
    expect(errors).toEqual([]);
    expect(layers.map((l) => [l.score, l.name])).toEqual([
      ["paragraphs", "paragraph labels"],
      ["tokens", "probes"],
      ["tokens", "more probes"],
    ]);
    expect(new Set(layers.map((l) => l.id)).size).toBe(3);
  });

  it("keeps the valid layers when another layer or score is invalid", () => {
    const { layers, errors } = collectAnnotationLayers(
      {
        broken: testScore({ metadata: { text_annotations: { version: 9 } } }),
        mixed: annotatedScore([
          rawLayer({ name: "bad", parts: [rawPart({ message_id: "gone" })] }),
          rawLayer({ name: "good" }),
        ]),
      },
      kMessages
    );
    expect(layers.map((l) => l.name)).toEqual(["good"]);
    expect(errors).toHaveLength(2);
    expect(errors.join("\n")).toMatch(/version 9/);
    expect(errors.join("\n")).toMatch(/gone not found/);
  });

  it("finds nothing without annotations", () => {
    expect(collectAnnotationLayers({ a: testScore() }, kMessages)).toEqual({
      layers: [],
      errors: [],
    });
    expect(collectAnnotationLayers(null, kMessages).layers).toEqual([]);
  });

  it("ignores the old span_labels and token_values keys", () => {
    const { layers } = collectAnnotationLayers(
      {
        old: testScore({
          metadata: { span_labels: { version: 0 }, token_values: {} },
        }),
      },
      kMessages
    );
    expect(layers).toEqual([]);
  });
});

describe("resolving a layer", () => {
  it("orders parts by transcript with each kind of text", () => {
    const layer = resolvedLayer(
      rawLayer({
        parts: [
          rawPart({
            message_id: "t1",
            starts: [0],
            ends: [2],
            values: { deception: [1] },
          }),
          rawPart({
            message_id: "a1",
            content_index: 1,
            starts: [0, 4],
            ends: [4, 5],
            values: { deception: [1, 2] },
          }),
          rawPart({
            message_id: "a1",
            content_index: 0,
            starts: [0, 4],
            ends: [3, 7],
            values: { deception: [1, 2] },
          }),
          rawPart(),
        ],
      }),
      kMessages
    );
    expect(
      layer.parts.map((p) => [p.messageId, p.contentIndex, p.kind])
    ).toEqual([
      ["u1", null, "text"],
      ["a1", 0, "reasoning"],
      ["a1", 1, "text"],
      ["t1", null, "text"],
    ]);
    expect(layer.parts.map((p) => p.index)).toEqual([0, 1, 2, 3]);
    expect(spans(layer.parts[0])).toEqual(["Solve", "the", "maze."]);
    expect(spans(layer.parts[1])).toEqual(["Map", "it "]);
    expect(layer.spanCount).toBe(8);
  });

  it("keeps spans after emoji on their characters", () => {
    // Each emoji is one code point but two UTF-16 units: slicing with the
    // raw offsets would shift every later span.
    const messages = [testUserMessage({ id: "u1", content: "🧭 Go 👋🏽 north" })];
    const layer = resolvedLayer(
      rawLayer({
        parts: [
          rawPart({
            starts: [0, 2, 5, 8],
            ends: [1, 4, 7, 13],
            values: { deception: [0, 0, 0, 0] },
          }),
        ],
      }),
      messages
    );
    expect(spans(layer.parts[0])).toEqual(["🧭", "Go", "👋🏽", "north"]);
  });

  it("rejects a part whose message is missing", () => {
    expect(
      errorOf(rawLayer({ parts: [rawPart({ message_id: "gone" })] }))
    ).toMatch(/gone not found/);
  });

  it.each([
    ["string content addressed by index", { content_index: 0 }],
    [
      "array content addressed as a string",
      { message_id: "a1", content_index: null },
    ],
    ["a content index past the parts", { message_id: "a1", content_index: 5 }],
  ])("rejects %s", (_name, overrides) => {
    expect(errorOf(rawLayer({ parts: [rawPart(overrides)] }))).toMatch(
      /not a text or reasoning part/
    );
  });

  it("rejects a span past the end of the text, counted in code points", () => {
    const messages = [testUserMessage({ id: "u1", content: "🙂🙂" })];
    const layer = (end: number) =>
      rawLayer({
        parts: [
          rawPart({ starts: [0], ends: [end], values: { deception: [1] } }),
        ],
      });
    expect(errorOf(layer(2), messages)).toBeUndefined();
    expect(errorOf(layer(3), messages)).toMatch(/past the text/);
  });
});

describe("codePointOffsets", () => {
  it("maps code-point offsets to UTF-16 indices", () => {
    expect(codePointOffsets("a🧭b")).toEqual([0, 1, 3, 4]);
    expect(codePointOffsets("")).toEqual([0]);
  });

  it("counts a lone surrogate as one code point, like Array.from", () => {
    const text = "a\ud800b";
    expect(codePointOffsets(text)).toHaveLength(Array.from(text).length + 1);
  });
});
