import { describe, expect, it } from "vitest";

import {
  testAssistantMessage,
  testUserMessage,
} from "@tsmono/inspect-common/testing";
import type { ChatMessage } from "@tsmono/inspect-common/types";

import {
  formatSpanOffsets,
  locateSpan,
  parseSpanOffsets,
  type SpanPosition,
} from "./position";
import { kindField, rawPart, rawSet, resolvedSet } from "./testFixtures";

const kMessages: ChatMessage[] = [
  // The emoji is two UTF-16 units but one code point.
  testUserMessage({ id: "u1", content: "🧭 Map it. Then go." }),
  testAssistantMessage({
    id: "a1",
    content: [{ type: "text", text: "First.\n\nSecond." }],
  }),
];

const part = (
  message_id: string,
  content_index: number | null,
  starts: number[],
  ends: number[]
) =>
  rawPart({
    message_id,
    content_index,
    starts,
    ends,
    values: { kind: starts.map(() => "task_work") },
  });

const kSet = resolvedSet(
  rawSet({
    fields: [kindField],
    parts: [part("a1", 0, [0, 8], [6, 15]), part("u1", null, [2, 10], [9, 18])],
  }),
  kMessages
);

describe("locateSpan", () => {
  it("finds the span at a position by its stored code-point offsets", () => {
    expect(
      locateSpan(kSet, {
        messageId: "u1",
        contentIndex: null,
        start: 10,
        end: 18,
      })
    ).toEqual({ part: 0, span: 1 });
    expect(
      locateSpan(kSet, {
        messageId: "a1",
        contentIndex: 0,
        start: 8,
        end: 15,
      })
    ).toEqual({ part: 1, span: 1 });
  });

  it("finds nothing where the set has no span with exactly those ends", () => {
    const misses: SpanPosition[] = [
      { messageId: "a1", contentIndex: 0, start: 8, end: 14 },
      { messageId: "a1", contentIndex: 1, start: 8, end: 15 },
      { messageId: "a2", contentIndex: 0, start: 8, end: 15 },
    ];
    for (const position of misses) {
      expect(locateSpan(kSet, position)).toBeUndefined();
    }
  });
});

describe("span offsets as text", () => {
  it("round-trips a position with and without a content index", () => {
    const positions: SpanPosition[] = [
      { messageId: "a1", contentIndex: 0, start: 8, end: 15 },
      { messageId: "u1", contentIndex: null, start: 2, end: 9 },
    ];
    for (const position of positions) {
      expect(
        parseSpanOffsets(position.messageId, formatSpanOffsets(position))
      ).toEqual(position);
    }
    expect(
      formatSpanOffsets({ messageId: "a", contentIndex: 3, start: 1, end: 4 })
    ).toBe("3:1-4");
  });

  it("rejects text that isn't offsets", () => {
    for (const text of ["", "1-4", "a:1-4", "0:1", "0:4-1", "0:-1-4"]) {
      expect(parseSpanOffsets("m", text)).toBeUndefined();
    }
  });
});
