// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  testAssistantMessage,
  testToolCall,
  testToolMessage,
  testUserMessage,
} from "@tsmono/inspect-common/testing";
import type { ChatMessage } from "@tsmono/inspect-common/types";
import { ComponentNavigationProvider } from "@tsmono/react/components";
import { ComponentStateProvider } from "@tsmono/react/state";
import {
  makeStateHooks,
  ResizeObserverStub,
  TrustedContentWrapper,
} from "@tsmono/react/testing";

import { ChatMessageRow } from "./ChatMessageRow";
import {
  MessagePartRendererContext,
  type MessagePartRenderer,
  type PartRenderOptions,
} from "./MessagePartRenderer";
import { resolveMessages } from "./messages";

vi.stubGlobal("ResizeObserver", ResizeObserverStub);

afterEach(() => {
  cleanup();
});

const kMessages: ChatMessage[] = [
  testUserMessage({ id: "u1", content: "**Hello** there" }),
  testAssistantMessage({
    id: "a1",
    content: [
      { type: "reasoning", reasoning: "Think it over.", redacted: false },
      {
        type: "text",
        text: "Plain answer.",
        refusal: null,
        internal: null,
        citations: null,
      },
    ],
    tool_calls: [testToolCall({ id: "c1", function: "bash" })],
  }),
  testToolMessage({ id: "t1", tool_call_id: "c1", content: "tool says hi" }),
];

const renderRows = (renderer?: MessagePartRenderer) => {
  const rows = resolveMessages(kMessages).map((resolved, index) => (
    <ChatMessageRow
      key={index}
      index={index}
      parentName="test"
      resolvedMessage={resolved}
    />
  ));
  const withRenderer = (children: ReactNode) =>
    renderer ? (
      <MessagePartRendererContext.Provider value={renderer}>
        {children}
      </MessagePartRendererContext.Provider>
    ) : (
      children
    );
  return render(
    <TrustedContentWrapper>
      <ComponentStateProvider hooks={makeStateHooks()}>
        <ComponentNavigationProvider navigation={{ navigate: () => {} }}>
          {withRenderer(rows)}
        </ComponentNavigationProvider>
      </ComponentStateProvider>
    </TrustedContentWrapper>
  );
};

/** Draws the parts named by `drawn` ("messageId:index") as a marker. */
const markerRenderer = (
  drawn: string[],
  calls: Array<[string, number | null, PartRenderOptions]> = []
): MessagePartRenderer => ({
  renderPart: (message, contentIndex, options) => {
    const key = `${message.id}:${contentIndex}`;
    calls.push([message.id ?? "", contentIndex, options]);
    return drawn.includes(key) ? <div>drawn {key}</div> : undefined;
  },
  startsExpanded: () => true,
});

describe("chat views and the message part renderer", () => {
  it("render every part as usual without a part renderer", async () => {
    const { container } = renderRows();
    expect((await screen.findByText("Hello")).tagName).toBe("STRONG");
    expect(screen.getByText("Think it over.")).toBeTruthy();
    expect(screen.getByText("Plain answer.")).toBeTruthy();
    expect(screen.getByText("tool says hi")).toBeTruthy();
    expect(container.textContent).not.toContain("drawn");
  });

  it("render as usual when the renderer draws nothing", async () => {
    renderRows(markerRenderer([]));
    expect((await screen.findByText("Hello")).tagName).toBe("STRONG");
    expect(screen.getByText("Plain answer.")).toBeTruthy();
    expect(screen.getByText("tool says hi")).toBeTruthy();
  });

  it("draw the parts the renderer returns in place of their usual rendering", async () => {
    const calls: Array<[string, number | null, PartRenderOptions]> = [];
    const { container } = renderRows(
      markerRenderer(["u1:null", "a1:1"], calls)
    );
    expect(await screen.findByText("drawn u1:null")).toBeTruthy();
    expect(screen.getByText("drawn a1:1")).toBeTruthy();
    expect(container.textContent).not.toContain("Hello");
    expect(container.textContent).not.toContain("Plain answer.");
    // The reasoning part is left to the chat.
    expect(screen.getByText("Think it over.")).toBeTruthy();
    expect(calls).toContainEqual(["a1", 0, { toolOutput: false }]);
  });

  it("draw a tool message's parts as the tool call's output", async () => {
    const calls: Array<[string, number | null, PartRenderOptions]> = [];
    const { container } = renderRows(markerRenderer(["t1:null"], calls));
    expect(await screen.findByText("drawn t1:null")).toBeTruthy();
    expect(container.textContent).not.toContain("tool says hi");
    expect(calls).toContainEqual(["t1", null, { toolOutput: true }]);
  });
});
