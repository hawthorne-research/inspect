import { describe, expect, it } from "vitest";

import {
  testAssistantMessage,
  testUserMessage,
} from "@tsmono/inspect-common/testing";
import type {
  ChatMessage,
  ContentReasoning,
} from "@tsmono/inspect-common/types";

import type { AnnotationField } from "./format";
import type { ResolvedLayer } from "./layers";
import {
  buildStrip,
  previewText,
  type LabelSegment,
  type PeakBin,
} from "./strip";
import {
  kindField,
  probeField,
  rawLayer,
  rawPart,
  resolvedLayer,
} from "./testFixtures";

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

const part = (
  message_id: string,
  content_index: number,
  starts: number[],
  ends: number[],
  kind = "task_work"
) =>
  rawPart({
    message_id,
    content_index,
    starts,
    ends,
    values: {
      kind: starts.map(() => kind),
      deception: starts.map((_, i) => i + 1),
    },
  });

const layer = (parts: unknown[], messages = kMessages): ResolvedLayer =>
  resolvedLayer(rawLayer({ fields: [kindField, probeField], parts }), messages);

const field = (l: ResolvedLayer, name: string): AnnotationField => {
  const found = l.fields.find((f) => f.name === name);
  if (!found) throw new Error(name);
  return found;
};

const segments = (
  l: ResolvedLayer,
  numbers?: Map<string, number>
): LabelSegment[] => {
  const strip = buildStrip(l, field(l, "kind"), numbers);
  return strip.type === "categorical" ? strip.segments : [];
};

const bins = (l: ResolvedLayer): PeakBin[] => {
  const strip = buildStrip(l, field(l, "deception"));
  return strip.type === "numeric" ? strip.bins : [];
};

describe("buildStrip for a categorical field", () => {
  it("orders spans by message, then content index, then start", () => {
    const l = layer([
      part("a2", 0, [0], [7]),
      part("a1", 1, [0], [6]),
      part("a1", 0, [0, 8], [6, 15]),
    ]);
    expect(segments(l).map((s) => s.preview)).toEqual([
      "First.",
      "Second.",
      "Third.",
      "Fourth.",
    ]);
  });

  it("marks the first segment of each message", () => {
    const l = layer([
      part("a1", 0, [0], [6]),
      part("a1", 1, [0], [6]),
      part("a2", 0, [0], [7]),
    ]);
    expect(segments(l).map((s) => s.startsMessage)).toEqual([
      true,
      false,
      true,
    ]);
  });

  it("numbers messages from the chip numbers, else by position", () => {
    const l = layer([part("a1", 0, [0], [6]), part("a2", 0, [0], [7])]);
    expect(
      segments(l, new Map([["a1", 5]])).map((s) => s.messageNumber)
    ).toEqual([5, 3]);
  });

  it("locates each segment's span and label", () => {
    const l = layer([part("a2", 0, [0], [7], "mapping")]);
    expect(segments(l).map((s) => [s.location, s.label])).toEqual([
      [{ part: 0, span: 0 }, "mapping"],
    ]);
  });

  it("cuts previews by code point", () => {
    const messages = [
      testAssistantMessage({ id: "a1", content: [reasoning("🧭 Go north.")] }),
    ];
    const [segment] = segments(layer([part("a1", 0, [2], [11])], messages));
    expect(segment?.preview).toBe("Go north.");
  });
});

describe("buildStrip for a numeric field", () => {
  it("bins every span in transcript order and locates each peak", () => {
    const l = layer([part("a2", 0, [0], [7]), part("a1", 0, [0, 8], [6, 15])]);
    expect(bins(l).map((b) => [b.peak, b.location, b.text])).toEqual([
      [1, { part: 0, span: 0 }, "First."],
      [2, { part: 0, span: 1 }, "Second."],
      [1, { part: 1, span: 0 }, "Fourth."],
    ]);
  });
});

describe("previewText", () => {
  it("collapses whitespace onto one line", () => {
    expect(previewText("  Plan:\n\n- step one\n")).toBe("Plan: - step one");
  });

  it("truncates long spans with an ellipsis", () => {
    expect(previewText("abcdef ghij", 7)).toBe("abcdef…");
  });
});
