// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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
  type AxisParams,
  type SeriesParams,
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

const series = (
  set: string,
  field: string,
  overrides: Partial<SeriesParams> = {}
): SeriesParams => ({
  set,
  field,
  aggregation: "mean",
  reference: null,
  axis: 0,
  ...overrides,
});

const kFitted: AxisParams = { min: null, max: null };

const kParams: AlongTranscriptParams = {
  x: "P(eval)",
  series: [
    series("P(eval)", "p_eval", { reference: 0.5 }),
    series("monitor", "log10_p", { axis: 1 }),
  ],
  axes: [kFitted, kFitted],
  marker: { set: "confidence", field: "confidence" },
  messageBoundaries: true,
  groupBy: "outcome",
  columns: 2,
};

/** Four series on three axes, the last two sharing the outer right one. */
const kFourSeries: AlongTranscriptParams = {
  ...kParams,
  series: [
    ...kParams.series,
    series("probes", "deception", { axis: 2 }),
    series("probes", "deception", { aggregation: "max", axis: 2 }),
  ],
  axes: [{ min: 0, max: 1 }, kFitted, kFitted],
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
      [...marks("axis 2", "text")].map((text) => text.textContent)
    ).toEqual(["-12", "-10", "-8", "-6", "-4", "-2"]);
    // The viewer's CSP blocks <style> elements.
    expect(svg.querySelector("style")).toBeNull();
    await plotOf("epoch 2: user, 3 paragraphs");
  });

  it("draws each axis with its own ticks and label, the right ones outwards", async () => {
    render(
      <AlongTranscriptView
        view={alongTranscript(table, samples, kFourSeries)}
        palette={kPalette}
        onSelectSpan={() => {}}
      />
    );
    const svg = await plotOf("epoch 1: grader, 3 paragraphs");
    const texts = (description: string) =>
      [...svg.querySelectorAll(`[aria-description="${description}"] text`)].map(
        (text) => text.textContent
      );
    expect(
      svg.querySelectorAll('[aria-description^="series"] path')
    ).toHaveLength(4);
    expect(texts("axis 1")).toEqual(["0", "0.2", "0.4", "0.6", "0.8", "1"]);
    expect(texts("axis 2")).toEqual(["-12", "-10", "-8", "-6", "-4", "-2"]);
    expect(texts("axis 3")).toEqual(["0", "5", "10", "15", "20"]);
    expect(texts("axis 1 label")).toEqual(["p_eval"]);
    expect(texts("axis 2 label")).toEqual(["log10_p"]);
    expect(texts("axis 3 label")).toEqual(["deception"]);
    const shift = (description: string) => {
      const transform =
        svg
          .querySelector(`[aria-description="${description}"]`)
          ?.getAttribute("transform") ?? "";
      return Number(/translate\(([-\d.]+)/.exec(transform)?.[1] ?? 0);
    };
    expect(shift("axis 3")).toBeGreaterThan(shift("axis 2"));
  });

  it("has one legend for every panel, with each series' axis and the markers' positive options", () => {
    render(
      <AlongTranscriptView
        view={alongTranscript(table, samples, kFourSeries)}
        palette={kPalette}
        onSelectSpan={() => {}}
      />
    );
    const legend = screen.getByRole("list", { name: "Legend" });
    const items = within(legend)
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(items.slice(0, 4)).toEqual([
      "P(eval) · p_evalleft axis0.5",
      "monitor · log10_pright axis",
      "probes · deception (mean per paragraph)outer right axis",
      "probes · deception (max per paragraph)outer right axis",
    ]);
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
        sets={table.sets}
        scores={sampleScores(table, samples)}
        onChange={onChange}
      />
    );
    return onChange;
  };

  it("changes a series' field without touching the rest", () => {
    const onChange = renderControls({
      ...kParams,
      axes: [kFitted, { min: -20, max: 0 }],
    });
    fireEvent.change(screen.getByLabelText("Series 2 field"), {
      target: { value: JSON.stringify(["probes", "deception"]) },
    });
    // The series' own axis is fitted afresh to the new field.
    expect(onChange).toHaveBeenCalledWith({
      ...kParams,
      series: [kParams.series[0], series("probes", "deception", { axis: 1 })],
      axes: [kFitted, kFitted],
    });
  });

  it("offers an aggregation only for a series that is rolled up", () => {
    renderControls(kParams);
    expect(screen.queryByLabelText(/aggregation/)).toBeNull();
    cleanup();
    renderControls({
      ...kParams,
      series: [series("probes", "deception", { aggregation: "max" })],
      axes: [kFitted],
    });
    expect(
      screen.getByLabelText<HTMLSelectElement>("Series 1 aggregation").value
    ).toBe("max");
  });

  it("adds a series on a new axis with the first numeric field", () => {
    const onChange = renderControls(kParams);
    fireEvent.click(screen.getByRole("button", { name: "Add series" }));
    expect(onChange).toHaveBeenCalledWith({
      ...kParams,
      series: [...kParams.series, series("P(eval)", "p_eval", { axis: 2 })],
      axes: [kFitted, kFitted, kFitted],
    });
  });

  it("puts a series on another axis, renumbering the axes", () => {
    const onChange = renderControls(kFourSeries);
    const axis = screen.getByLabelText<HTMLSelectElement>("Series 2 axis");
    expect([...axis.options].map((option) => option.text)).toEqual([
      "1 (left)",
      "2 (right)",
      "3 (outer right)",
    ]);
    fireEvent.change(axis, { target: { value: "2" } });
    expect(onChange).toHaveBeenLastCalledWith({
      ...kFourSeries,
      series: kFourSeries.series.map((s, i) => ({
        ...s,
        axis: i === 0 ? 0 : 1,
      })),
      axes: [{ min: 0, max: 1 }, kFitted],
    });
    // A series sharing an axis can move to a new one.
    fireEvent.change(screen.getByLabelText("Series 4 axis"), {
      target: { value: "3" },
    });
    expect(onChange.mock.lastCall?.[0].series.map((s) => s.axis)).toEqual([
      0, 1, 2, 3,
    ]);
  });

  it("removes a series, renumbering the axes", () => {
    const onChange = renderControls(kFourSeries);
    fireEvent.click(screen.getByRole("button", { name: "Remove series 2" }));
    const [s0, , s2, s3] = kFourSeries.series;
    expect(onChange).toHaveBeenCalledWith({
      ...kFourSeries,
      series: [s0, { ...s2, axis: 1 }, { ...s3, axis: 1 }],
      axes: [{ min: 0, max: 1 }, kFitted],
    });
  });

  it("sets an axis's range on the row of its first series", () => {
    const onChange = renderControls(kFourSeries);
    expect(screen.getAllByLabelText("Axis 3 min")).toHaveLength(1);
    const row = screen.getByRole("group", { name: "Series 3" });
    fireEvent.change(within(row).getByLabelText("Axis 3 max"), {
      target: { value: "25" },
    });
    expect(onChange).toHaveBeenCalledWith({
      ...kFourSeries,
      axes: [{ min: 0, max: 1 }, kFitted, { min: null, max: 25 }],
    });
    expect(
      within(screen.getByRole("group", { name: "Series 4" })).queryByLabelText(
        /^Axis/
      )
    ).toBeNull();
  });
});
