import { describe, expect, it } from "vitest";

import {
  testAssistantMessage,
  testSystemMessage,
  testToolMessage,
  testUserMessage,
} from "@tsmono/inspect-common/testing";
import type {
  ChatMessage,
  ContentReasoning,
  ContentText,
} from "@tsmono/inspect-common/types";

import { kMergedSystemMessageId, resolveMessages } from "..";

import { chatPartFinder, hasAnnotatedPart } from "./chatParts";
import { rawLayer, rawPart, resolvedLayer } from "./model/testFixtures";

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
  testSystemMessage({ id: "s0", content: "Unannotated." }),
  testSystemMessage({ id: "s1", content: "Be brief." }),
  testUserMessage({ id: "u1", content: "Solve the maze." }),
  testAssistantMessage({
    id: "a1",
    content: [reasoning("Map it first."), textPart("Done.")],
  }),
  testToolMessage({ id: "t1", content: "ok" }),
];

const layer = resolvedLayer(
  rawLayer({
    parts: [
      rawPart({
        message_id: "s1",
        starts: [0],
        ends: [2],
        values: { deception: [1] },
      }),
      rawPart(),
      rawPart({
        message_id: "a1",
        content_index: 1,
        starts: [0],
        ends: [4],
        values: { deception: [1] },
      }),
    ],
  }),
  kMessages
);
const find = chatPartFinder(layer, kMessages);

describe("chatPartFinder", () => {
  it("finds a string content's part and an array content's part", () => {
    const [, , user, assistant, tool] = kMessages;
    if (!user || !assistant || !tool) throw new Error();
    expect(find(user, null)?.messageId).toBe("u1");
    expect(find(assistant, 0)).toBeUndefined();
    expect(find(assistant, 1)?.contentIndex).toBe(1);
    expect(hasAnnotatedPart(find, assistant)).toBe(true);
    expect(hasAnnotatedPart(find, tool)).toBe(false);
  });

  it("maps the merged system row back to its system messages", () => {
    const [systemRow] = resolveMessages(kMessages);
    const message = systemRow?.message;
    if (!message) throw new Error();
    expect(message.id).toBe(kMergedSystemMessageId);
    expect(find(message, 0)).toBeUndefined();
    expect(find(message, 1)?.messageId).toBe("s1");
    expect(hasAnnotatedPart(find, message)).toBe(true);
  });
});
