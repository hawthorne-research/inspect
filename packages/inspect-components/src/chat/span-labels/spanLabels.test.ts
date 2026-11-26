import { describe, expect, it } from "vitest";

import {
  testAssistantMessage,
  testScore,
  testUserMessage,
} from "@tsmono/inspect-common/testing";
import type {
  ChatMessage,
  ContentReasoning,
  ContentText,
} from "@tsmono/inspect-common/types";

import {
  checkSpanTargets,
  countLabels,
  findSpanLabels,
  groupSpansByPart,
  labelledReasoningParts,
  labelText,
  optionMark,
  parseSpanLabels,
  segmentText,
  type LabelledSpan,
  type SpanLabels,
} from "./spanLabels";

const reasoning = (text: string): ContentReasoning => ({
  type: "reasoning",
  reasoning: text,
  redacted: false,
});

const textPart = (text: string): ContentText => ({ type: "text", text });

const kReasoning = "First I map the maze.\n\nThen I solve it.";

const kMessages: ChatMessage[] = [
  testUserMessage({ id: "u1", content: "Solve this maze." }),
  testAssistantMessage({
    id: "a1",
    content: [reasoning(kReasoning), textPart("Done.")],
  }),
];

const rawSpan = (overrides: Record<string, unknown> = {}) => ({
  message_id: "a1",
  content_index: 0,
  start: 0,
  end: 21,
  labels: { kind: "mapping", suspects_test: "no" },
  probabilities: {
    kind: { mapping: 0.9, task_work: 0.1 },
    suspects_test: { yes: 0.2, no: 0.8 },
  },
  ...overrides,
});

const rawLabels = (spans: unknown[] = [rawSpan()]) => ({
  version: 0,
  unit: "paragraph",
  classifier: "random",
  questions: [
    { name: "kind", description: null, options: ["task_work", "mapping"] },
    {
      name: "suspects_test",
      description: "Does the model suspect a test?",
      options: ["yes", "no"],
    },
  ],
  spans,
});

const parsed = (raw: unknown): SpanLabels => {
  const result = parseSpanLabels(raw);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

const span = (start: number, end: number): LabelledSpan => ({
  message_id: "a1",
  content_index: 0,
  start,
  end,
  labels: {},
  probabilities: {},
});

describe("findSpanLabels", () => {
  it("returns the first score's span_labels", () => {
    const scores = {
      accuracy: testScore({ value: 1 }),
      labels: testScore({ metadata: { span_labels: "first" } }),
      later: testScore({ metadata: { span_labels: "second" } }),
    };
    expect(findSpanLabels(scores)).toBe("first");
  });

  it("returns undefined when no score carries labels", () => {
    expect(findSpanLabels({ accuracy: testScore() })).toBeUndefined();
    expect(findSpanLabels(null)).toBeUndefined();
  });
});

describe("parseSpanLabels", () => {
  it("accepts valid data", () => {
    const labels = parsed(rawLabels());
    expect(labels.classifier).toBe("random");
    expect(labels.questions.map((q) => q.name)).toEqual([
      "kind",
      "suspects_test",
    ]);
    expect(labels.spans[0]?.labels).toEqual({
      kind: "mapping",
      suspects_test: "no",
    });
  });

  it.each([
    ["a non-object", "nope"],
    ["an unknown version", { ...rawLabels(), version: 1 }],
    ["no questions", { ...rawLabels(), questions: [] }],
    ["an empty span", rawLabels([rawSpan({ start: 5, end: 5 })])],
    ["a negative offset", rawLabels([rawSpan({ start: -1 })])],
    ["a fractional offset", rawLabels([rawSpan({ end: 2.5 })])],
    [
      "a label outside its options",
      rawLabels([rawSpan({ labels: { kind: "x" } })]),
    ],
    [
      "a label for an unknown question",
      rawLabels([rawSpan({ labels: { mood: "x" } })]),
    ],
    [
      "a probability outside [0, 1]",
      rawLabels([rawSpan({ probabilities: { kind: { mapping: 1.5 } } })]),
    ],
  ])("rejects %s", (_name, raw) => {
    expect(parseSpanLabels(raw).ok).toBe(false);
  });

  it("rejects overlapping spans in one content part", () => {
    const result = parseSpanLabels(
      rawLabels([
        rawSpan({ start: 10, end: 30 }),
        rawSpan({ start: 0, end: 11 }),
      ])
    );
    expect(!result.ok && result.error).toMatch(/overlap/);
  });

  it("allows spans that touch, and spans in different parts", () => {
    const result = parseSpanLabels(
      rawLabels([
        rawSpan({ start: 0, end: 10 }),
        rawSpan({ start: 10, end: 20 }),
        rawSpan({ content_index: 1, start: 0, end: 5 }),
      ])
    );
    expect(result.ok).toBe(true);
  });
});

describe("checkSpanTargets", () => {
  it("accepts spans inside their part's text", () => {
    expect(checkSpanTargets(parsed(rawLabels()), kMessages)).toBeUndefined();
  });

  it("reports a missing message", () => {
    const labels = parsed(rawLabels([rawSpan({ message_id: "gone" })]));
    expect(checkSpanTargets(labels, kMessages)).toMatch(/gone not found/);
  });

  it("reports an offset past the end of the text", () => {
    const length = Array.from(kReasoning).length;
    const labels = parsed(rawLabels([rawSpan({ end: length + 1 })]));
    expect(checkSpanTargets(labels, kMessages)).toMatch(/past the text/);
  });

  it("reports a content index with no text part", () => {
    const labels = parsed(rawLabels([rawSpan({ content_index: 5 })]));
    expect(checkSpanTargets(labels, kMessages)).toMatch(/not a reasoning/);
  });

  it("measures text parts in code points", () => {
    const messages = [
      testAssistantMessage({ id: "a1", content: [reasoning("🙂🙂")] }),
    ];
    const fits = parsed(rawLabels([rawSpan({ start: 0, end: 2 })]));
    const tooLong = parsed(rawLabels([rawSpan({ start: 0, end: 3 })]));
    expect(checkSpanTargets(fits, messages)).toBeUndefined();
    expect(checkSpanTargets(tooLong, messages)).toMatch(/past the text/);
  });
});

describe("segmentText", () => {
  it("splits text into labelled paragraphs, dropping blank gaps", () => {
    const result = segmentText(kReasoning, [span(0, 21), span(23, 39)]);
    expect(result.ok && result.value.map((s) => s.text)).toEqual([
      "First I map the maze.",
      "Then I solve it.",
    ]);
  });

  it("keeps unlabelled text between spans as its own segment", () => {
    const result = segmentText(kReasoning, [span(23, 39)]);
    expect(
      result.ok && result.value.map((s) => [s.text, s.span !== undefined])
    ).toEqual([
      ["First I map the maze.\n\n", false],
      ["Then I solve it.", true],
    ]);
  });

  it("slices by code point when non-BMP characters precede a span", () => {
    // Each emoji is one code point but two UTF-16 units, so String.slice
    // with these offsets would cut two characters short.
    const text = "🧭🧭 Go north.\n\nThen east.";
    const result = segmentText(text, [span(0, 12), span(14, 24)]);
    expect(result.ok && result.value.map((s) => s.text)).toEqual([
      "🧭🧭 Go north.",
      "Then east.",
    ]);
  });

  it("fails on an offset past the end of the text", () => {
    expect(segmentText("short", [span(0, 6)]).ok).toBe(false);
  });

  it("fails on overlapping spans", () => {
    expect(segmentText(kReasoning, [span(0, 10), span(5, 20)]).ok).toBe(false);
  });
});

describe("labelledReasoningParts", () => {
  it("maps each labelled reasoning part object to its spans", () => {
    const labels = parsed(
      rawLabels([rawSpan(), rawSpan({ content_index: 1, start: 0, end: 5 })])
    );
    const message = kMessages[1];
    if (!message || typeof message.content === "string") throw new Error();
    const parts = labelledReasoningParts(
      groupSpansByPart(labels.spans),
      message
    );
    // the text part's span is not a reasoning part, so it is left out
    expect(parts?.size).toBe(1);
    expect(parts?.get(reasoning(kReasoning))).toBeUndefined();
    const [first] = message.content;
    expect(first?.type === "reasoning" && parts?.get(first)).toHaveLength(1);
  });

  it("returns undefined for a message without labelled parts", () => {
    const labels = parsed(rawLabels());
    const user = kMessages[0];
    if (!user) throw new Error();
    expect(
      labelledReasoningParts(groupSpansByPart(labels.spans), user)
    ).toBeUndefined();
  });
});

describe("countLabels and optionMark", () => {
  it("counts each option in question order", () => {
    const labels = parsed(
      rawLabels([
        rawSpan(),
        rawSpan({ start: 23, end: 39, labels: { kind: "mapping" } }),
      ])
    );
    const kind = labels.questions[0];
    if (!kind) throw new Error();
    expect(countLabels(labels, kind)).toEqual([
      { option: "task_work", count: 0 },
      { option: "mapping", count: 2 },
    ]);
  });

  it("colours by option index, with yes/no as strong/neutral", () => {
    const labels = parsed(rawLabels());
    const [kind, suspects] = labels.questions;
    if (!kind || !suspects) throw new Error();
    expect(optionMark(kind, "mapping")).toEqual({
      color: "var(--inspect-span-label-2)",
      hollow: false,
    });
    expect(optionMark(suspects, "yes").color).toBe(
      "var(--inspect-span-label-yes)"
    );
    expect(optionMark(suspects, "no").color).toBe(
      "var(--inspect-span-label-none)"
    );
  });

  it("reuses hues hollow past the eight-colour palette", () => {
    const options = Array.from({ length: 11 }, (_, i) => `o${i}`);
    const kind = { name: "kind", description: null, options };
    expect(optionMark(kind, "o7")).toEqual({
      color: "var(--inspect-span-label-8)",
      hollow: false,
    });
    expect(optionMark(kind, "o9")).toEqual({
      color: "var(--inspect-span-label-2)",
      hollow: true,
    });
  });

  it("names the question on bare yes/no labels", () => {
    const question = { name: "test_awareness", description: null, options: [] };
    expect(labelText(question, "no")).toBe("test_awareness: no");
    expect(labelText(question, "checking_work")).toBe("checking_work");
  });
});
