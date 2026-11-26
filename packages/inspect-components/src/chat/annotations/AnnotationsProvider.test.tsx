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
import { kPartAttribute, kSpanAttribute } from "./dom";
import type { ResolvedLayer } from "./layers";
import { buildStrip } from "./strip";
import {
  kindField,
  probeField,
  rawLayer,
  rawPart,
  resolvedLayer,
  viewOf,
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

// Short spans on u1 ("**Hi**" | "🧭" | "there", with the spaces as gaps)
// and two long ones on a1's reasoning paragraphs. Each span has a
// categorical and a numeric value.
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
      probabilities: {
        kind: [
          [0.2, 0.8],
          [0.4, 0.6],
          [0.9, 0.1],
        ],
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

const renderAnnotated = (
  fieldName: string,
  { layers, highlight }: { layers?: ResolvedLayer[]; highlight?: string[] } = {}
) => {
  const layer = resolvedLayer(kLayer, kMessages);
  const view = viewOf(layer, fieldName, highlight);
  return render(
    <TrustedContentWrapper>
      <ComponentStateProvider hooks={makeStateHooks()}>
        <ComponentNavigationProvider navigation={{ navigate: () => {} }}>
          <AnnotationsProvider view={view}>
            <AnnotationLegend
              view={view}
              layers={layers ?? [layer]}
              strip={buildStrip(view)}
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

/** What a message's annotated part shows: its text, whether any markdown
 *  rendered, and each span's tag, text and whether it is tinted. */
const drawnPart = (messageId: string) => {
  const part = screen
    .getByTestId(messageId)
    .querySelector<HTMLElement>(`[${kPartAttribute}]`);
  if (!part) throw new Error(`no annotated part in ${messageId}`);
  return {
    text: part.textContent,
    markdown: part.querySelector("strong, em") !== null,
    spans: spansIn(part).map((s) => [
      s.tagName,
      s.textContent,
      s.style.backgroundColor !== "",
    ]),
  };
};

describe("annotated parts", () => {
  it("draw categorical values on short spans and numeric values on long spans the same way", () => {
    renderAnnotated("kind");
    expect(drawnPart("u1")).toEqual({
      text: "**Hi** 🧭  there",
      markdown: false,
      spans: [
        ["SPAN", "**Hi**", true],
        ["SPAN", "🧭", true],
        ["SPAN", "there", true],
      ],
    });
    cleanup();
    renderAnnotated("deception");
    expect(drawnPart("a1")).toEqual({
      text: "Go north.\n\nThen *east*.",
      markdown: false,
      spans: [
        ["SPAN", "Go north.", true],
        ["SPAN", "Then *east*.", true],
      ],
    });
  });

  it("leave a span with no value to show uncoloured", () => {
    renderAnnotated("deception");
    expect(drawnPart("u1").spans.map(([, , tinted]) => tinted)).toEqual([
      true,
      false,
      true,
    ]);
  });

  it("render reasoning under its heading", () => {
    renderAnnotated("kind");
    const assistant = screen.getByTestId("a1");
    expect(within(assistant).getByText("Reasoning")).toBeTruthy();
    expect(spansIn(assistant)).toHaveLength(2);
  });

  it("fade the spans of options the legend's highlight leaves out", () => {
    renderAnnotated("kind", { highlight: ["task_work"] });
    expect(
      spansIn(screen.getByTestId("u1")).map((s) => s.style.opacity)
    ).toEqual(["0.3", "0.3", ""]);
  });

  it("show every field of a hovered span's layer in the shared tooltip", () => {
    renderAnnotated("deception");
    const [, , there] = spansIn(screen.getByTestId("u1"));
    if (!there) throw new Error();
    fireEvent.mouseOver(there);
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.textContent).toContain('"there"');
    expect(within(tooltip).getByText("deception · layer 12")).toBeTruthy();
    expect(within(tooltip).getByText("-2")).toBeTruthy();
    expect(within(tooltip).getByText("kind")).toBeTruthy();
    expect(within(tooltip).getAllByText("task_work")).toHaveLength(2);
    const optionRow = (option: string) =>
      within(tooltip).getByTitle(option).parentElement?.textContent;
    expect(optionRow("task_work")).toBe("task_work90%");
    expect(optionRow("mapping")).toBe("mapping10%");
  });

  it("draw each value in the tooltip as a bar: probabilities, and numbers from zero", () => {
    renderAnnotated("deception");
    const [, , there] = spansIn(screen.getByTestId("u1"));
    if (!there) throw new Error();
    fireEvent.mouseOver(there);
    const tooltip = screen.getByRole("tooltip");
    const fills = (option: string) => {
      const row = within(tooltip).getByTitle(option).parentElement;
      return Array.from(
        row?.querySelectorAll<HTMLElement>('[style*="width"]') ?? []
      ).map((el) => el.style.width);
    };
    expect(fills("task_work")).toEqual(["90%"]);
    expect(fills("mapping")).toEqual(["10%"]);
    // -2 against the field's scale fills the left half of the bar.
    const numeric = within(tooltip)
      .getByText("-2")
      .parentElement?.querySelector<HTMLElement>('[style*="width"]');
    expect(numeric?.style.width).toMatch(/%$/);
    expect(Number.parseFloat(numeric?.style.width ?? "0")).toBeGreaterThan(0);
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
    renderAnnotated("kind", { layers: [layer] });
    expect(screen.queryByLabelText("Annotation layer")).toBeNull();
    cleanup();
    renderAnnotated("kind", { layers: [layer, other] });
    const picker = screen.getByLabelText("Annotation layer");
    expect(
      within(picker)
        .getAllByRole("option")
        .map((o) => o.textContent)
    ).toEqual(["probes · token", "paragraphs · paragraph"]);
  });

  it("sums up the layer's source, metadata and spans", () => {
    renderAnnotated("kind");
    const legend = screen.getByRole("region", { name: "Text annotations" });
    expect(
      within(legend).getByText(
        "test · tokenizer: tiktoken/o200k_base · 5 tokens"
      )
    ).toBeTruthy();
  });

  it("counts each option of a categorical field", () => {
    renderAnnotated("kind");
    const options = screen.getByRole("group", { name: "Options" });
    expect(
      within(options)
        .getAllByRole("button")
        .map((b) => b.textContent)
    ).toEqual(["task_work2", "mapping3"]);
  });

  it("shows a numeric field's scale instead of options", () => {
    renderAnnotated("deception");
    expect(screen.queryByRole("group", { name: "Options" })).toBeNull();
    expect(screen.getByTitle(/get full colour/)).toBeTruthy();
  });

  it("draws one strip segment per span", () => {
    renderAnnotated("kind");
    const strip = screen.getByRole("group", {
      name: "Spans in transcript order",
    });
    expect(within(strip).getAllByRole("button")).toHaveLength(5);
  });
});
