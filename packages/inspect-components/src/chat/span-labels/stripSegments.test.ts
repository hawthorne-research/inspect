import { describe, expect, it } from "vitest";

import {
  testAssistantMessage,
  testUserMessage,
} from "@tsmono/inspect-common/testing";
import type {
  ChatMessage,
  ContentReasoning,
} from "@tsmono/inspect-common/types";

import { isDimmed, type LabelledSpan, type SpanLabels } from "./spanLabels";
import { buildStripSegments, previewText } from "./stripSegments";

const reasoning = (text: string): ContentReasoning => ({
  type: "reasoning",
  reasoning: text,
  redacted: false,
});

const kMessages: ChatMessage[] = [
  testUserMessage({ id: "u1", content: "Map the maze." }),
  testAssistantMessage({
    id: "a1",
    content: [reasoning("First.\n\nSecond."), reasoning("Third.")],
  }),
  testAssistantMessage({ id: "a2", content: [reasoning("Fourth.")] }),
];

const span = (
  message_id: string,
  content_index: number,
  start: number,
  end: number,
  kind = "task_work"
): LabelledSpan => ({
  message_id,
  content_index,
  start,
  end,
  labels: { kind },
  probabilities: {},
});

const kind = {
  name: "kind",
  description: null,
  options: ["task_work", "mapping"],
};

const labels = (spans: LabelledSpan[]): SpanLabels => ({
  version: 0,
  unit: "paragraph",
  classifier: "random",
  questions: [kind],
  spans,
});

describe("buildStripSegments", () => {
  it("orders by message, then content index, then start", () => {
    const segments = buildStripSegments(
      labels([
        span("a2", 0, 0, 7),
        span("a1", 1, 0, 6),
        span("a1", 0, 8, 15),
        span("a1", 0, 0, 6),
      ]),
      kMessages
    );
    expect(segments.map((s) => s.preview)).toEqual([
      "First.",
      "Second.",
      "Third.",
      "Fourth.",
    ]);
  });

  it("marks the first segment of each message", () => {
    const segments = buildStripSegments(
      labels([span("a1", 0, 0, 6), span("a1", 1, 0, 6), span("a2", 0, 0, 7)]),
      kMessages
    );
    expect(segments.map((s) => s.startsMessage)).toEqual([true, false, true]);
  });

  it("numbers messages from the chip numbers, else by position", () => {
    const segments = buildStripSegments(
      labels([span("a1", 0, 0, 6), span("a2", 0, 0, 7)]),
      kMessages,
      new Map([["a1", 5]])
    );
    expect(segments.map((s) => s.messageNumber)).toEqual([5, 3]);
  });

  it("leaves out spans whose message is missing", () => {
    const segments = buildStripSegments(
      labels([span("gone", 0, 0, 3), span("a2", 0, 0, 7)]),
      kMessages
    );
    expect(segments.map((s) => s.span.message_id)).toEqual(["a2"]);
  });

  it("cuts previews by code point", () => {
    const messages = [
      testAssistantMessage({ id: "a1", content: [reasoning("🧭 Go north.")] }),
    ];
    const [segment] = buildStripSegments(
      labels([span("a1", 0, 2, 11)]),
      messages
    );
    expect(segment?.preview).toBe("Go north.");
  });
});

describe("previewText", () => {
  it("collapses whitespace onto one line", () => {
    expect(previewText(Array.from("  Plan:\n\n- step one\n"))).toBe(
      "Plan: - step one"
    );
  });

  it("truncates long paragraphs with an ellipsis", () => {
    expect(previewText(Array.from("abcdef ghij"), 7)).toBe("abcdef…");
  });
});

describe("isDimmed", () => {
  const mapping = span("a1", 0, 0, 6, "mapping");

  it("dims nothing without a highlight", () => {
    expect(isDimmed([], kind, mapping)).toBe(false);
  });

  it("dims spans whose label is not highlighted", () => {
    expect(isDimmed(["mapping"], kind, mapping)).toBe(false);
    expect(isDimmed(["task_work"], kind, mapping)).toBe(true);
    expect(isDimmed(["task_work"], kind, undefined)).toBe(true);
  });
});
