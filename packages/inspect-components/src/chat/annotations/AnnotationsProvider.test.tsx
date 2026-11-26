// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  testAssistantMessage,
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

import { ChatMessageRow, resolveMessages } from "..";

import { AnnotationLegend } from "./AnnotationLegend";
import { AnnotationsProvider } from "./AnnotationsProvider";
import type { AnnotationView } from "./context";
import { kPartAttribute, kSpanAttribute } from "./dom";
import type { ResolvedLayer } from "./layers";
import { valueScale } from "./numeric";
import { buildStrip } from "./strip";
import {
  kindField,
  probeField,
  rawLayer,
  rawPart,
  resolvedLayer,
} from "./testFixtures";

vi.stubGlobal("ResizeObserver", ResizeObserverStub);

afterEach(() => {
  cleanup();
});

const kMessages: ChatMessage[] = [
  testUserMessage({ id: "u1", content: "**Hi** 🧭  there" }),
  testAssistantMessage({
    id: "a1",
    content: [
      {
        type: "reasoning",
        reasoning: "Go north.\n\nThen *east*.",
        redacted: false,
      },
    ],
  }),
  testUserMessage({ id: "u2", content: "**Not annotated**" }),
];

// "**Hi**" | "🧭" | "there", with the spaces as gaps; two reasoning
// paragraphs. Each span has a categorical and a numeric value.
const kLayer = rawLayer({
  fields: [kindField, probeField],
  parts: [
    rawPart({
      message_id: "u1",
      starts: [0, 7, 10],
      ends: [6, 8, 15],
      values: {
        kind: ["mapping", "mapping", "task_work"],
        deception: [2, 0, -2],
      },
    }),
    rawPart({
      message_id: "a1",
      content_index: 0,
      starts: [0, 11],
      ends: [9, 23],
      values: { kind: ["mapping", "task_work"], deception: [1, 1] },
    }),
  ],
});

const viewOf = (layer: ResolvedLayer, fieldName: string): AnnotationView => {
  const field = layer.fields.find((f) => f.name === fieldName);
  if (!field) throw new Error(fieldName);
  return {
    layer,
    field,
    scale: field.type === "numeric" ? valueScale(layer, field) : 0,
    highlighted: [],
  };
};

const renderAnnotated = (fieldName: string, layers?: ResolvedLayer[]) => {
  const layer = resolvedLayer(kLayer, kMessages);
  const view = viewOf(layer, fieldName);
  return render(
    <TrustedContentWrapper>
      <ComponentStateProvider hooks={makeStateHooks()}>
        <ComponentNavigationProvider navigation={{ navigate: () => {} }}>
          <AnnotationsProvider view={view}>
            <AnnotationLegend
              view={view}
              layers={layers ?? [layer]}
              strip={buildStrip(layer, view.field)}
              onLayerChange={() => {}}
              onFieldChange={() => {}}
              onToggleHighlight={() => {}}
              onClearHighlight={() => {}}
              onSelectSpan={() => {}}
            />
            {resolveMessages(kMessages).map((resolved, index) => (
              <div key={index} data-testid={resolved.message.id}>
                <ChatMessageRow
                  index={index}
                  parentName="test"
                  resolvedMessage={resolved}
                />
              </div>
            ))}
          </AnnotationsProvider>
        </ComponentNavigationProvider>
      </ComponentStateProvider>
    </TrustedContentWrapper>
  );
};

const spansIn = (element: HTMLElement): HTMLElement[] =>
  Array.from(element.querySelectorAll<HTMLElement>(`[${kSpanAttribute}]`));

describe("a numeric field", () => {
  it("renders the raw text, not markdown, keeping whitespace", () => {
    renderAnnotated("deception");
    const part = screen
      .getByTestId("u1")
      .querySelector<HTMLElement>(`[${kPartAttribute}]`);
    expect(part?.textContent).toBe("**Hi** 🧭  there");
    expect(part?.querySelector("strong")).toBeNull();
  });

  it("renders one span per value, with the gaps between them uncoloured", () => {
    renderAnnotated("deception");
    const spans = spansIn(screen.getByTestId("u1"));
    expect(spans.map((s) => s.textContent)).toEqual(["**Hi**", "🧭", "there"]);
    expect(spans.map((s) => s.style.backgroundColor !== "")).toEqual([
      true,
      false,
      true,
    ]);
  });

  it("renders reasoning under its heading", () => {
    renderAnnotated("deception");
    const assistant = screen.getByTestId("a1");
    expect(within(assistant).getByText("Reasoning")).toBeTruthy();
    expect(spansIn(assistant).map((s) => s.textContent)).toEqual([
      "Go north.",
      "Then *east*.",
    ]);
  });

  it("shows a hovered span's values in the shared tooltip", () => {
    renderAnnotated("deception");
    const [, , there] = spansIn(screen.getByTestId("u1"));
    if (!there) throw new Error();
    fireEvent.mouseOver(there);
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.textContent).toContain('"there"');
    expect(tooltip.textContent).toContain("-2");
    expect(tooltip.textContent).toContain("task_work");
  });
});

describe("a categorical field", () => {
  it("renders each span as a labelled markdown paragraph", async () => {
    renderAnnotated("kind");
    const assistant = screen.getByTestId("a1");
    const spans = spansIn(assistant);
    expect(spans).toHaveLength(2);
    expect(within(spans[0] ?? assistant).getByText("mapping")).toBeTruthy();
    expect(
      (await within(spans[1] ?? assistant).findByText("east")).tagName
    ).toBe("EM");
  });
});

describe("messages without spans in the layer", () => {
  it.each(["kind", "deception"])("render as usual (%s)", async (field) => {
    renderAnnotated(field);
    const plain = screen.getByTestId("u2");
    expect((await within(plain).findByText("Not annotated")).tagName).toBe(
      "STRONG"
    );
    expect(spansIn(plain)).toEqual([]);
  });
});

describe("the legend", () => {
  it("offers a layer picker only when there is more than one layer", () => {
    const layer = resolvedLayer(kLayer, kMessages);
    const other = resolvedLayer(
      rawLayer({ name: "paragraphs", unit: "paragraph", parts: [] }),
      kMessages
    );
    renderAnnotated("kind", [layer]);
    expect(screen.queryByLabelText("Annotation layer")).toBeNull();
    cleanup();
    renderAnnotated("kind", [layer, other]);
    const picker = screen.getByLabelText("Annotation layer");
    expect(
      within(picker)
        .getAllByRole("option")
        .map((o) => o.textContent)
    ).toEqual(["probes · token", "paragraphs · paragraph"]);
  });

  it("counts each option of a categorical field", () => {
    renderAnnotated("kind");
    const legend = screen.getByRole("region", { name: "Text annotations" });
    expect(
      within(legend)
        .getAllByRole("button", { pressed: false })
        .map((b) => b.textContent)
    ).toEqual(["task_work2", "mapping3"]);
  });
});
