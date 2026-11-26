// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  testAssistantMessage,
  testScore,
  testUserMessage,
} from "@tsmono/inspect-common/testing";
import type { ChatMessage } from "@tsmono/inspect-common/types";

import { hoveredToken, kTokenAttribute } from "./tokenDom";
import { TokenValuedContent } from "./TokenValuedContent";
import { loadTokenValues, messageTokenParts } from "./tokenValues";
import type { TokenValuesView } from "./TokenValuesContext";

afterEach(() => {
  cleanup();
});

const kUser = testUserMessage({ id: "u1", content: "**Hi** 🧭  there" });
const kAssistant = testAssistantMessage({
  id: "a1",
  content: [{ type: "reasoning", reasoning: "Go north.", redacted: false }],
});
const kMessages: ChatMessage[] = [kUser, kAssistant];

const view = (): TokenValuesView => {
  const result = loadTokenValues(
    {
      probes: testScore({
        metadata: {
          token_values: {
            version: 0,
            unit: "token",
            tokenizer: "test",
            probes: [{ name: "p", description: null, layer: 3 }],
            parts: [
              // "**Hi**" | "🧭" | "there", with the spaces as gaps
              {
                message_id: "u1",
                content_index: null,
                starts: [0, 7, 10],
                ends: [6, 8, 15],
                values: { p: [2, 0, -2] },
              },
              {
                message_id: "a1",
                content_index: 0,
                starts: [0, 3],
                ends: [2, 9],
                values: { p: [1, 1] },
              },
            ],
          },
        },
      }),
    },
    kMessages
  );
  if (!result?.ok) throw new Error(result?.error ?? "no token values");
  return {
    values: result.value,
    probe: { name: "p", description: null, layer: 3 },
    scale: 2,
  };
};

const renderMessage = (message: ChatMessage) => {
  const tokenValues = view();
  const parts = messageTokenParts(tokenValues.values, message);
  if (!parts) throw new Error("no parts");
  return render(
    <TokenValuedContent
      contents={message.content}
      parts={parts}
      view={tokenValues}
    />
  );
};

const tokenSpans = (container: HTMLElement): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>(`[${kTokenAttribute}]`));

describe("TokenValuedContent", () => {
  it("renders the raw text, not markdown, keeping whitespace", () => {
    const { container } = renderMessage(kUser);
    expect(container.textContent).toBe("**Hi** 🧭  there");
    expect(container.querySelector("strong")).toBeNull();
  });

  it("renders one span per token, with the gaps between them uncoloured", () => {
    const { container } = renderMessage(kUser);
    const spans = tokenSpans(container);
    expect(spans.map((s) => s.textContent)).toEqual(["**Hi**", "🧭", "there"]);
    expect(spans.map((s) => s.style.backgroundColor !== "")).toEqual([
      true,
      false,
      true,
    ]);
  });

  it("renders reasoning under a heading", () => {
    const { container, getByText } = renderMessage(kAssistant);
    expect(getByText("Reasoning")).toBeTruthy();
    expect(tokenSpans(container).map((s) => s.textContent)).toEqual([
      "Go",
      "north.",
    ]);
  });

  it("finds the hovered token from any element inside it", () => {
    const tokenValues = view();
    const { container } = renderMessage(kUser);
    const [, , there] = tokenSpans(container);
    const hovered = hoveredToken(there ?? null, tokenValues.values);
    expect(hovered?.part.messageId).toBe("u1");
    expect(hovered?.token).toBe(2);
    expect(hoveredToken(container, tokenValues.values)).toBeNull();
  });
});
