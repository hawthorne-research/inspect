// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ResizeObserverStub } from "@tsmono/react/testing";

import { colorScheme, type Palette } from "../chat/annotations/model";

import { AlongTranscriptControls } from "./AlongTranscriptControls";
import { AlongTranscriptView } from "./AlongTranscriptView";
import {
  alongTranscript,
  sampleScores,
  type AlongTranscriptParams,
} from "./model";
import { fixtureTable, type FixtureSample } from "./model/testFixtures";

vi.stubGlobal("ResizeObserver", ResizeObserverStub);

afterEach(() => {
  cleanup();
});

const kPalette: Palette = { scheme: colorScheme("default"), dark: false };

const full = (epoch: number, outcome: string): FixtureSample => ({
  epoch,
  outcome,
  pEval: [0.2, 0.6, 0.9],
  log10: [-12, -6, -3],
  confidence: ["likely", "none", "possible"],
  probes: [1, 3, -2, 4, 10, 20],
});

const kParams: AlongTranscriptParams = {
  x: "P(eval)",
  series: [
    {
      layer: "P(eval)",
      field: "p_eval",
      aggregation: "mean",
      reference: 0.5,
      min: null,
      max: null,
    },
    {
      layer: "monitor",
      field: "log10_p",
      aggregation: "mean",
      reference: null,
      min: null,
      max: null,
    },
  ],
  marker: { layer: "confidence", field: "confidence" },
  messageBoundaries: true,
  groupBy: "outcome",
  columns: 2,
};

const { table, samples } = fixtureTable([full(1, "grader"), full(2, "user")]);

/** The plot under the panel titled `title`, once it has loaded. */
const plotOf = async (title: string): Promise<SVGSVGElement> => {
  const figure = (await screen.findByText(title)).closest("figure");
  return waitFor(() => {
    const svg = figure?.querySelector("svg");
    if (!svg) throw new Error(`no plot under ${title}`);
    return svg;
  });
};

describe("AlongTranscriptView", () => {
  it("draws each panel's series, markers, message starts and reference", async () => {
    render(
      <AlongTranscriptView
        view={alongTranscript(table, samples, kParams)}
        palette={kPalette}
        onSelectSpan={() => {}}
      />
    );
    const svg = await plotOf("epoch 1: grader, 3 paragraphs");
    const marks = (description: string, element: string) =>
      svg.querySelectorAll(`[aria-description="${description}"] ${element}`);
    expect(marks("series 1", "path")).toHaveLength(1);
    expect(marks("series 2", "path")).toHaveLength(1);
    expect(marks("markers", "line")).toHaveLength(2);
    expect(marks("message starts", "line")).toHaveLength(1);
    expect(marks("reference", "line")).toHaveLength(1);
    // The right axis is labelled in the second series' units.
    expect(
      [...marks("right axis", "text")].map((text) => text.textContent)
    ).toEqual(["-12", "-10", "-8", "-6", "-4", "-2"]);
    // The viewer's CSP blocks <style> elements.
    expect(svg.querySelector("style")).toBeNull();
    await plotOf("epoch 2: user, 3 paragraphs");
  });

  it("has one legend for every panel, with the markers' positive options", () => {
    render(
      <AlongTranscriptView
        view={alongTranscript(table, samples, kParams)}
        palette={kPalette}
        onSelectSpan={() => {}}
      />
    );
    const legend = screen.getByRole("list", { name: "Legend" });
    expect(legend.textContent).toContain("P(eval) · p_eval");
    expect(legend.textContent).toContain("monitor · log10_p");
    expect(legend.textContent).toContain("likely");
    expect(legend.textContent).toContain("possible");
    expect(legend.textContent).not.toContain("none");
    expect(screen.getAllByRole("list", { name: "Legend" })).toHaveLength(1);
  });
});

describe("AlongTranscriptControls", () => {
  const renderControls = (params: AlongTranscriptParams) => {
    const onChange = vi.fn<(params: AlongTranscriptParams) => void>();
    render(
      <AlongTranscriptControls
        params={params}
        view={alongTranscript(table, samples, params)}
        layers={table.layers}
        scores={sampleScores(table, samples)}
        onChange={onChange}
      />
    );
    return onChange;
  };

  it("changes a series without touching the rest", () => {
    const onChange = renderControls(kParams);
    fireEvent.change(screen.getByLabelText("Right series"), {
      target: { value: JSON.stringify(["probes", "deception"]) },
    });
    expect(onChange).toHaveBeenCalledWith({
      ...kParams,
      series: [
        kParams.series[0],
        {
          layer: "probes",
          field: "deception",
          aggregation: "mean",
          reference: null,
          min: null,
          max: null,
        },
      ],
    });
  });

  it("offers an aggregation only for a series that is rolled up", () => {
    renderControls(kParams);
    expect(screen.queryByLabelText(/aggregation/)).toBeNull();
    cleanup();
    renderControls({
      ...kParams,
      series: [
        {
          layer: "probes",
          field: "deception",
          aggregation: "max",
          reference: null,
          min: null,
          max: null,
        },
      ],
    });
    expect(
      screen.getByLabelText<HTMLSelectElement>("Left aggregation per paragraph")
        .value
    ).toBe("max");
  });
});
