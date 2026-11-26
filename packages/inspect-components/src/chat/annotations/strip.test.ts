import { describe, expect, it } from "vitest";

import {
  testAssistantMessage,
  testUserMessage,
} from "@tsmono/inspect-common/testing";
import type {
  ChatMessage,
  ContentReasoning,
} from "@tsmono/inspect-common/types";

import type { ResolvedLayer } from "./layers";
import { buildStrip } from "./strip";
import {
  flagField,
  kindField,
  probeField,
  rawLayer,
  rawPart,
  resolvedLayer,
  viewOf,
} from "./testFixtures";
import { spanStyle } from "./view";

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

interface SpanValues {
  kind?: string[];
  deception?: number[];
  flag?: string[];
}

const part = (
  message_id: string,
  content_index: number | null,
  starts: number[],
  ends: number[],
  values: SpanValues = {}
) =>
  rawPart({
    message_id,
    content_index,
    starts,
    ends,
    values: {
      kind: values.kind ?? starts.map(() => "task_work"),
      deception: values.deception ?? starts.map((_, i) => i + 1),
      flag: values.flag ?? starts.map(() => "0"),
    },
  });

const layer = (parts: unknown[]): ResolvedLayer =>
  resolvedLayer(
    rawLayer({ fields: [kindField, probeField, flagField], parts }),
    kMessages
  );

// "Map" "the" "maze."; "First." "Second."; "Third."; "Fourth."
const kAllSpans = [
  part("u1", null, [0, 4, 8], [3, 7, 13], {
    kind: ["mapping", "task_work", "mapping"],
    deception: [0.5, -4, 1],
    flag: ["0", "1", "0"],
  }),
  part("a1", 0, [0, 8], [6, 15]),
  part("a1", 1, [0], [6]),
  part("a2", 0, [0], [7]),
];

describe("buildStrip", () => {
  it("gives one segment per span, in transcript order", () => {
    const l = layer([
      part("a2", 0, [0], [7]),
      part("a1", 1, [0], [6]),
      part("a1", 0, [0, 8], [6, 15]),
    ]);
    const segments = buildStrip(viewOf(l, "kind"));
    expect(segments.map((s) => [s.text, s.count])).toEqual([
      ["First.", 1],
      ["Second.", 1],
      ["Third.", 1],
      ["Fourth.", 1],
    ]);
  });

  it("marks where each message after the first begins", () => {
    const segments = buildStrip(viewOf(layer(kAllSpans), "kind"));
    expect(segments.map((s) => s.startsMessage)).toEqual([
      false,
      false,
      false,
      true,
      false,
      false,
      true,
    ]);
  });

  it("numbers messages from the chip numbers, else by position", () => {
    const l = layer([part("a1", 0, [0], [6]), part("a2", 0, [0], [7])]);
    const segments = buildStrip(viewOf(l, "kind"), new Map([["a1", 5]]));
    expect(segments.map((s) => s.messageNumber)).toEqual([5, 3]);
  });

  it("cuts more spans than segments into runs of equal count", () => {
    const segments = buildStrip(
      viewOf(layer(kAllSpans), "deception"),
      new Map(),
      3
    );
    expect(segments.map((s) => s.count)).toEqual([2, 2, 3]);
  });

  it("marks a run in which a message begins", () => {
    const segments = buildStrip(
      viewOf(layer(kAllSpans), "deception"),
      new Map(),
      3
    );
    expect(segments.map((s) => s.startsMessage)).toEqual([false, true, true]);
  });

  it("shows a numeric run by its peak", () => {
    const l = layer(kAllSpans);
    const view = viewOf(l, "deception");
    const [first] = buildStrip(view, new Map(), 3);
    expect(first).toMatchObject({
      location: { part: 0, span: 1 },
      label: "peak -4",
      text: "the",
    });
    const shown = l.parts[0];
    if (!shown) throw new Error();
    expect(first?.style).toEqual(spanStyle(view, shown, 1));
  });

  it("shows a categorical run by the first span of its most frequent option", () => {
    const segments = buildStrip(viewOf(layer(kAllSpans), "kind"), new Map(), 2);
    expect(segments.map((s) => [s.label, s.text])).toEqual([
      ["mapping (2)", "Map"],
      ["task_work (4)", "First."],
    ]);
  });

  it("shows a run of a yes/no field by its tinted option", () => {
    const view = viewOf(layer(kAllSpans), "flag");
    const [first, second] = buildStrip(view, new Map(), 2);
    expect(first).toMatchObject({ label: "1 (1)", text: "the" });
    expect(first?.style).toBeDefined();
    expect(second).toMatchObject({ label: "0 (4)", text: "First." });
    expect(second?.style).toBeUndefined();
  });

  it("is empty without spans", () => {
    expect(buildStrip(viewOf(layer([]), "kind"))).toEqual([]);
  });
});
