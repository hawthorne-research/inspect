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

import { kMergedSystemMessageId, resolveMessages } from "../messages";

import {
  codePointOffsets,
  findTokenValues,
  loadTokenValues,
  messageTokenParts,
  parseTokenValues,
  tokenText,
  type LoadedTokenValues,
  type TokenPart,
} from "./tokenValues";

const reasoning = (text: string): ContentReasoning => ({
  type: "reasoning",
  reasoning: text,
  redacted: false,
});

const textPart = (text: string): ContentText => ({ type: "text", text });

const kMessages: ChatMessage[] = [
  testSystemMessage({ id: "s1", content: "Be brief." }),
  testUserMessage({ id: "u1", content: "Solve the maze." }),
  testAssistantMessage({
    id: "a1",
    content: [reasoning("Map it first."), textPart("Done.")],
  }),
  testToolMessage({ id: "t1", content: "ok" }),
];

const probes = [
  { name: "deception", description: "Linear probe", layer: 12 },
  { name: "eval_awareness", description: null, layer: null },
];

const rawPart = (overrides: Record<string, unknown> = {}) => ({
  message_id: "u1",
  content_index: null,
  starts: [0, 6, 10],
  ends: [5, 9, 15],
  values: { deception: [0.5, -1, 2], eval_awareness: [0, 0, 0] },
  ...overrides,
});

const rawValues = (
  parts: unknown[] = [rawPart()],
  overrides: Record<string, unknown> = {}
) => ({
  version: 0,
  unit: "token",
  tokenizer: "tiktoken/o200k_base",
  probes,
  parts,
  ...overrides,
});

const scoresWith = (raw: unknown) => ({
  probes: testScore({ value: 0, metadata: { token_values: raw } }),
});

const loaded = (
  raw: unknown,
  messages: ChatMessage[] = kMessages
): LoadedTokenValues => {
  const result = loadTokenValues(scoresWith(raw), messages);
  if (!result?.ok) throw new Error(result?.error ?? "no token values");
  return result.value;
};

const tokens = (part: TokenPart | undefined): string[] =>
  part ? part.starts.map((_, i) => tokenText(part, i)) : [];

describe("findTokenValues", () => {
  it("returns the first score's token_values", () => {
    const scores = {
      accuracy: testScore(),
      probes: testScore({ metadata: { token_values: "first" } }),
      later: testScore({ metadata: { token_values: "second" } }),
    };
    expect(findTokenValues(scores)).toBe("first");
  });

  it("returns undefined when no score carries values", () => {
    expect(findTokenValues({ accuracy: testScore() })).toBeUndefined();
    expect(loadTokenValues(null, kMessages)).toBeUndefined();
  });
});

describe("parseTokenValues", () => {
  it("accepts valid data", () => {
    const result = parseTokenValues(rawValues());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.probes).toEqual(probes);
    expect(result.value.parts[0]?.values["deception"]).toEqual([0.5, -1, 2]);
  });

  it("accepts tokens with gaps between them, and no parts", () => {
    expect(parseTokenValues(rawValues([rawPart()])).ok).toBe(true);
    expect(parseTokenValues(rawValues([])).ok).toBe(true);
  });

  it("fills a missing description and layer with null", () => {
    const result = parseTokenValues(rawValues([], { probes: [{ name: "p" }] }));
    expect(result.ok && result.value.probes).toEqual([
      { name: "p", description: null, layer: null },
    ]);
  });

  const values = (deception: unknown, eval_awareness: unknown = [0, 0, 0]) =>
    rawPart({ values: { deception, eval_awareness } });

  it.each([
    ["a non-object", "nope"],
    ["an unknown version", rawValues([], { version: 1 })],
    ["a missing tokenizer", rawValues([], { tokenizer: undefined })],
    ["no probes", rawValues([], { probes: [] })],
    ["an unnamed probe", rawValues([], { probes: [{ name: "" }] })],
    [
      "a duplicate probe name",
      rawValues([], { probes: [{ name: "p" }, { name: "p" }] }),
    ],
    [
      "a non-numeric layer",
      rawValues([], { probes: [{ name: "p", layer: "x" }] }),
    ],
    ["a part without a message id", rawValues([rawPart({ message_id: "" })])],
    [
      "a missing content index",
      rawValues([rawPart({ content_index: undefined })]),
    ],
    ["a negative content index", rawValues([rawPart({ content_index: -1 })])],
    ["unequal starts and ends", rawValues([rawPart({ ends: [5, 9] })])],
    ["a negative start", rawValues([rawPart({ starts: [-1, 6, 10] })])],
    ["a fractional offset", rawValues([rawPart({ ends: [5, 9.5, 15] })])],
    ["an empty token", rawValues([rawPart({ starts: [0, 6, 15] })])],
    ["overlapping tokens", rawValues([rawPart({ starts: [0, 4, 10] })])],
    [
      "a missing probe's values",
      rawValues([rawPart({ values: { deception: [0, 0, 0] } })]),
    ],
    [
      "values for an unknown probe",
      rawValues([
        rawPart({
          values: {
            deception: [0, 0, 0],
            eval_awareness: [0, 0, 0],
            other: [0, 0, 0],
          },
        }),
      ]),
    ],
    ["too few values", rawValues([values([1, 2])])],
    ["a non-finite value", rawValues([values([1, Number.NaN, 2])])],
    ["a non-numeric value", rawValues([values([1, "2", 3])])],
    ["two parts for one content part", rawValues([rawPart(), rawPart()])],
  ])("rejects %s", (_name, raw) => {
    expect(parseTokenValues(raw).ok).toBe(false);
  });
});

describe("loadTokenValues", () => {
  it("resolves parts in transcript order with each kind of text", () => {
    const values = loaded(
      rawValues([
        rawPart({
          message_id: "t1",
          starts: [0],
          ends: [2],
          values: { deception: [1], eval_awareness: [0] },
        }),
        rawPart({
          message_id: "a1",
          content_index: 1,
          starts: [0, 4],
          ends: [4, 5],
          values: { deception: [1, 2], eval_awareness: [0, 0] },
        }),
        rawPart({
          message_id: "a1",
          content_index: 0,
          starts: [0, 4],
          ends: [3, 7],
          values: { deception: [1, 2], eval_awareness: [0, 0] },
        }),
        rawPart(),
      ])
    );
    expect(
      values.parts.map((p) => [p.messageId, p.contentIndex, p.kind])
    ).toEqual([
      ["u1", null, "text"],
      ["a1", 0, "reasoning"],
      ["a1", 1, "text"],
      ["t1", null, "text"],
    ]);
    expect(values.parts.map((p) => p.index)).toEqual([0, 1, 2, 3]);
    expect(tokens(values.parts[0])).toEqual(["Solve", "the", "maze."]);
    expect(tokens(values.parts[1])).toEqual(["Map", "it "]);
    expect(values.tokenCount).toBe(8);
  });

  it("keeps tokens after emoji on their characters", () => {
    // Each emoji is one code point but two UTF-16 units: slicing with the
    // raw offsets would shift every later token.
    const messages = [testUserMessage({ id: "u1", content: "🧭 Go 👋🏽 north" })];
    const values = loaded(
      rawValues([
        rawPart({
          starts: [0, 2, 5, 8],
          ends: [1, 4, 7, 13],
          values: { deception: [0, 0, 0, 0], eval_awareness: [0, 0, 0, 0] },
        }),
      ]),
      messages
    );
    expect(tokens(values.parts[0])).toEqual(["🧭", "Go", "👋🏽", "north"]);
  });

  it("rejects a part whose message is missing", () => {
    const result = loadTokenValues(
      scoresWith(rawValues([rawPart({ message_id: "gone" })])),
      kMessages
    );
    expect(result?.ok === false && result.error).toMatch(/gone not found/);
  });

  it.each([
    ["string content addressed by index", { content_index: 0 }],
    [
      "array content addressed as a string",
      { message_id: "a1", content_index: null },
    ],
    ["a content index past the parts", { message_id: "a1", content_index: 5 }],
  ])("rejects %s", (_name, overrides) => {
    const result = loadTokenValues(
      scoresWith(rawValues([rawPart(overrides)])),
      kMessages
    );
    expect(result?.ok === false && result.error).toMatch(
      /not a text or reasoning part/
    );
  });

  it("rejects a token past the end of the text, counted in code points", () => {
    const messages = [testUserMessage({ id: "u1", content: "🙂🙂" })];
    const part = (end: number) =>
      rawValues([
        rawPart({
          starts: [0],
          ends: [end],
          values: { deception: [1], eval_awareness: [1] },
        }),
      ]);
    expect(loadTokenValues(scoresWith(part(2)), messages)?.ok).toBe(true);
    const tooLong = loadTokenValues(scoresWith(part(3)), messages);
    expect(tooLong?.ok === false && tooLong.error).toMatch(/past the text/);
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

describe("messageTokenParts", () => {
  const values = loaded(
    rawValues([
      rawPart({
        message_id: "s1",
        starts: [0],
        ends: [2],
        values: { deception: [1], eval_awareness: [0] },
      }),
      rawPart(),
      rawPart({
        message_id: "a1",
        content_index: 1,
        starts: [0],
        ends: [4],
        values: { deception: [1], eval_awareness: [0] },
      }),
    ])
  );

  it("finds a string content's part", () => {
    const user = kMessages[1];
    if (!user) throw new Error();
    expect(messageTokenParts(values, user)?.whole?.messageId).toBe("u1");
  });

  it("keys array parts by the part object", () => {
    const assistant = kMessages[2];
    if (!assistant || typeof assistant.content === "string") {
      throw new Error();
    }
    const parts = messageTokenParts(values, assistant);
    const [first, second] = assistant.content;
    expect(first && parts?.byPart.get(first)).toBeUndefined();
    expect(second && parts?.byPart.get(second)?.contentIndex).toBe(1);
  });

  it("maps the merged system row back to its system messages", () => {
    const [systemRow] = resolveMessages(kMessages);
    const message = systemRow?.message;
    if (!message || typeof message.content === "string") throw new Error();
    expect(message.id).toBe(kMergedSystemMessageId);
    const [entry] = message.content;
    expect(
      entry && messageTokenParts(values, message)?.byPart.get(entry)?.messageId
    ).toBe("s1");
  });

  it("is undefined for a message without values", () => {
    const tool = kMessages[3];
    if (!tool) throw new Error();
    expect(messageTokenParts(values, tool)).toBeUndefined();
  });
});
