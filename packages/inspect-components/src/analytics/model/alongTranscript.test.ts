import { describe, expect, it } from "vitest";

import { setId } from "../../chat/annotations/model";

import {
  alongTranscript,
  axisName,
  defaultParams,
  kPlotDomain,
  normalizeAxes,
  resolveParams,
  type AlongTranscriptParams,
  type AxisParams,
  type Panel,
  type SeriesParams,
} from "./alongTranscript";
import { fixtureTable, type FixtureSample } from "./testFixtures";

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

const fitted: AxisParams = { min: null, max: null };

const params = (
  overrides: Partial<AlongTranscriptParams> = {}
): AlongTranscriptParams => ({
  x: "P(eval)",
  series: [
    series("P(eval)", "p_eval"),
    series("monitor", "log10_p", { axis: 1 }),
  ],
  axes: [fitted, fitted],
  marker: { set: "confidence", field: "confidence" },
  messageBoundaries: true,
  groupBy: "outcome",
  columns: 2,
  ...overrides,
});

const panels = (view: ReturnType<typeof alongTranscript>): Panel[] =>
  view.groups.flatMap((group) => group.panels);

describe("alongTranscript", () => {
  const { table, samples } = fixtureTable([
    full(3, "user"),
    full(2, "grader"),
    // Without the monitor's set.
    { ...full(4, "grader"), log10: undefined },
    full(1, "grader"),
  ]);

  it("has a panel per sample with every chosen set, grouped by score, then by epoch", () => {
    const view = alongTranscript(table, samples, params());
    expect(
      view.groups.map((group) => ({
        value: group.value,
        epochs: group.panels.map((panel) => panel.sample.epoch),
      }))
    ).toEqual([
      { value: "grader", epochs: [1, 2] },
      { value: "user", epochs: [3] },
    ]);
    expect(view.omitted).toBe(1);
  });

  it("keeps samples without a set nothing asks for", () => {
    const view = alongTranscript(
      table,
      samples,
      params({ series: [series("P(eval)", "p_eval")] })
    );
    expect(panels(view).map((panel) => panel.sample.epoch)).toEqual([
      1, 2, 4, 3,
    ]);
  });

  it("titles panels with the epoch, score value and span count", () => {
    const view = alongTranscript(table, samples, params());
    expect(panels(view).map((panel) => panel.title)).toEqual([
      "epoch 1: grader, 3 paragraphs",
      "epoch 2: grader, 3 paragraphs",
      "epoch 3: user, 3 paragraphs",
    ]);
    const ungrouped = alongTranscript(
      table,
      samples,
      params({ groupBy: null })
    );
    expect(ungrouped.groups).toHaveLength(1);
    expect(panels(ungrouped)[0]?.title).toBe("epoch 1, 3 paragraphs");
  });

  it("names the sample in titles when samples have different ids", () => {
    const mixed = fixtureTable([
      full(1, "grader"),
      { ...full(1, "user"), id: "other" },
    ]);
    const view = alongTranscript(mixed.table, mixed.samples, params());
    expect(panels(view).map((panel) => panel.title)).toEqual([
      "maze epoch 1: grader, 3 paragraphs",
      "other epoch 1: user, 3 paragraphs",
    ]);
  });

  it("puts the x set's spans at 1, 2, ... with each series' value on them", () => {
    const [panel] = panels(alongTranscript(table, samples, params()));
    expect(panel?.spanCount).toBe(3);
    expect(
      panel?.points.map(({ x, values, messageIndex }) => ({
        x,
        values,
        messageIndex,
      }))
    ).toEqual([
      { x: 1, values: [0.2, -12], messageIndex: 1 },
      { x: 2, values: [0.6, -6], messageIndex: 1 },
      { x: 3, values: [0.9, -3], messageIndex: 3 },
    ]);
  });

  it("tells where each point's span is, and which set it is of", () => {
    const [panel] = panels(alongTranscript(table, samples, params()));
    expect(panel?.setId).toBe(setId("p_eval", "P(eval)"));
    expect(panel?.points.map((point) => point.position)).toEqual([
      { messageId: "a1", contentIndex: null, start: 0, end: 9 },
      { messageId: "a1", contentIndex: null, start: 11, end: 20 },
      { messageId: "a2", contentIndex: null, start: 0, end: 11 },
    ]);
  });

  it.each([
    ["mean", [2, 1, 15]],
    ["max", [3, 4, 20]],
    ["count", [2, 2, 2]],
  ] as const)(
    "rolls a finer set's field up onto the x spans by its %s",
    (aggregation, expected) => {
      const view = alongTranscript(
        table,
        samples,
        params({ series: [series("probes", "deception", { aggregation })] })
      );
      expect(panels(view)[0]?.points.map((p) => p.values[0])).toEqual(expected);
      expect(view.series[0]?.rolledUp).toBe(true);
      expect(view.series[0]?.label).toBe(
        `probes · deception (${aggregation} per paragraph)`
      );
    }
  );

  it("calls the x spans spans when the x set has no unit", () => {
    const unitless = fixtureTable([
      { ...full(1, "grader"), paragraphUnit: null },
    ]);
    expect(unitless.table.sets.find((s) => s.name === "P(eval)")?.unit).toBe(
      null
    );
    const view = alongTranscript(
      unitless.table,
      unitless.samples,
      params({ series: [series("probes", "deception")] })
    );
    expect(view.spanNoun).toBe("span");
    expect(panels(view)[0]?.title).toBe("epoch 1: grader, 3 spans");
    expect(view.series[0]?.label).toBe("probes · deception (mean per span)");
  });

  it("joins a set with the x set's spans without rolling it up", () => {
    const view = alongTranscript(
      table,
      samples,
      params({
        series: [series("monitor", "log10_p", { aggregation: "count" })],
      })
    );
    expect(panels(view)[0]?.points.map((p) => p.values[0])).toEqual([
      -12, -6, -3,
    ]);
    expect(view.series[0]?.rolledUp).toBe(false);
    expect(view.series[0]?.label).toBe("monitor · log10_p");
  });

  it("marks spans whose option is not negative", () => {
    const view = alongTranscript(table, samples, params());
    expect(panels(view)[0]?.markers).toEqual([
      { x: 1, option: "likely" },
      { x: 3, option: "possible" },
    ]);
    expect(panels(view)[0]?.points.map((p) => p.marker)).toEqual([
      "likely",
      "none",
      "possible",
    ]);
    expect(view.marker?.field.negative).toEqual(["none"]);
  });

  it("draws message boundaries between spans of different messages, when asked", () => {
    expect(
      panels(alongTranscript(table, samples, params()))[0]?.boundaries
    ).toEqual([2.5]);
    expect(
      panels(
        alongTranscript(table, samples, params({ messageBoundaries: false }))
      )[0]?.boundaries
    ).toEqual([]);
  });

  it("gives each axis a nice domain shared by every panel, with its series' references", () => {
    const view = alongTranscript(
      table,
      samples,
      params({
        series: [
          series("P(eval)", "p_eval", { reference: 0.5 }),
          series("monitor", "log10_p", { reference: -20, axis: 1 }),
        ],
      })
    );
    expect(view.axes.map((a) => a.domain)).toEqual([
      [0.2, 0.9],
      [-20, 0],
    ]);
  });

  it("fixes the axis ends an axis sets, and fits the others to the data", () => {
    const view = alongTranscript(
      table,
      samples,
      params({
        axes: [
          { min: 0, max: 1 },
          { min: null, max: 5 },
        ],
      })
    );
    expect(view.axes.map((a) => a.domain)).toEqual([
      [0, 1],
      [-12, 5],
    ]);
  });

  it("ignores fixed ends that leave no range", () => {
    const fitted = alongTranscript(table, samples, params());
    const view = alongTranscript(
      table,
      samples,
      params({
        axes: [
          { min: 1, max: 0 },
          { min: 50, max: null },
        ],
      })
    );
    expect(view.axes.map((a) => a.domain)).toEqual(
      fitted.axes.map((a) => a.domain)
    );
  });

  it("draws any number of series, on the left axis and then outwards on the right", () => {
    const view = alongTranscript(
      table,
      samples,
      params({
        series: [
          series("P(eval)", "p_eval"),
          series("monitor", "log10_p", { axis: 1 }),
          series("probes", "deception", { axis: 2 }),
          series("probes", "deception", { aggregation: "max", axis: 2 }),
        ],
        axes: [fitted, fitted, fitted],
      })
    );
    expect(panels(view)[0]?.points.map((p) => p.values)).toEqual([
      [0.2, -12, 2, 3],
      [0.6, -6, 1, 4],
      [0.9, -3, 15, 20],
    ]);
    expect(
      view.axes.map(({ name, side, position, series, label }) => ({
        name,
        side,
        position,
        series,
        label,
      }))
    ).toEqual([
      { name: "left", side: "left", position: 0, series: [0], label: "p_eval" },
      {
        name: "right",
        side: "right",
        position: 0,
        series: [1],
        label: "log10_p",
      },
      {
        name: "outer right",
        side: "right",
        position: 1,
        series: [2, 3],
        label: "deception",
      },
    ]);
    // The shared axis covers both series: the means from 1 and the maxima
    // up to 20.
    expect(view.axes[2]?.domain).toEqual([0, 20]);
  });

  it("labels a shared axis with its series' field names", () => {
    const view = alongTranscript(
      table,
      samples,
      params({
        series: [
          series("P(eval)", "p_eval", { reference: 2 }),
          series("monitor", "log10_p"),
        ],
        axes: [fitted],
      })
    );
    expect(view.axes).toHaveLength(1);
    expect(view.axes[0]?.label).toBe("p_eval, log10_p");
    expect(view.axes[0]?.domain).toEqual([-12, 2]);
  });

  it("maps every axis onto the plot's y scale", () => {
    const view = alongTranscript(table, samples, params());
    const [lo, hi] = kPlotDomain;
    for (const axis of view.axes) {
      expect(axis.toPlot(axis.domain[0])).toBeCloseTo(lo, 10);
      expect(axis.toPlot(axis.domain[1])).toBeCloseTo(hi, 10);
    }
    expect(view.axes[1]?.toPlot(-7)).toBeCloseTo(0.5, 10);
  });

  it("renumbers axes the parameters leave gaps in", () => {
    const view = alongTranscript(
      table,
      samples,
      params({
        series: [
          series("P(eval)", "p_eval", { axis: 2 }),
          series("monitor", "log10_p", { axis: 2 }),
        ],
      })
    );
    expect(view.params.series.map((s) => s.axis)).toEqual([0, 0]);
    expect(view.axes).toHaveLength(1);
  });

  it("has no panels when no sample has the x set", () => {
    const view = alongTranscript(
      table,
      samples,
      params({ x: "gone", series: [], axes: [], marker: null })
    );
    expect(panels(view)).toEqual([]);
    expect(view.omitted).toBe(4);
  });
});

describe("defaultParams", () => {
  it("starts from the first numeric set, aligned markers and the one sample score", () => {
    const { table, samples } = fixtureTable([
      { epoch: 1, outcome: "user", confidence: ["none", "none", "likely"] },
      full(2, "grader"),
    ]);
    expect(defaultParams(table, samples)).toEqual({
      x: "P(eval)",
      series: [series("P(eval)", "p_eval")],
      axes: [fitted],
      marker: { set: "confidence", field: "confidence" },
      messageBoundaries: true,
      groupBy: "outcome",
      columns: 2,
    });
  });

  it("doesn't mark with a set of other spans", () => {
    const { table, samples } = fixtureTable([
      { epoch: 1, pEval: [1, 2, 3], probes: [1, 2, 3, 4, 5, 6] },
    ]);
    const defaults = defaultParams(table, samples);
    expect(defaults.marker).toBeNull();
    expect(defaults.groupBy).toBeNull();
  });
});

describe("axisName", () => {
  it("names the left axis, then the right axes outwards", () => {
    expect([0, 1, 2, 3, 4].map(axisName)).toEqual([
      "left",
      "right",
      "outer right",
      "outer right 2",
      "outer right 3",
    ]);
  });
});

describe("normalizeAxes", () => {
  const axis = (min: number): AxisParams => ({ min, max: null });
  const onAxes = (...axes: number[]) =>
    axes.map((a) => series("P(eval)", "p_eval", { axis: a }));

  it("numbers axes in order of first use, keeping each axis's ends", () => {
    const normalized = normalizeAxes({
      series: onAxes(3, 3, 1, 0),
      axes: [axis(0), axis(1), axis(2), axis(3)],
    });
    expect(normalized.series.map((s) => s.axis)).toEqual([0, 0, 1, 2]);
    expect(normalized.axes).toEqual([axis(3), axis(1), axis(0)]);
  });

  it("fits an axis without ends and drops axes no series uses", () => {
    const normalized = normalizeAxes({
      series: onAxes(0, 5),
      axes: [axis(0), axis(1)],
    });
    expect(normalized.series.map((s) => s.axis)).toEqual([0, 1]);
    expect(normalized.axes).toEqual([axis(0), fitted]);
  });

  it("renumbers the axes after a series is removed", () => {
    const { series: all, axes } = normalizeAxes({
      series: onAxes(0, 1, 2, 2),
      axes: [axis(0), axis(1), axis(2)],
    });
    const normalized = normalizeAxes({
      series: all.filter((_, i) => i !== 1),
      axes,
    });
    expect(normalized.series.map((s) => s.axis)).toEqual([0, 1, 1]);
    expect(normalized.axes).toEqual([axis(0), axis(2)]);
  });
});

describe("resolveParams", () => {
  const { table, samples } = fixtureTable([full(1, "grader")]);
  const defaults = defaultParams(table, samples);

  it("keeps stored parameters the log has", () => {
    const stored = params({ x: "monitor", columns: 3 });
    expect(resolveParams(stored, table, samples)).toEqual(stored);
  });

  it("keeps an explicit choice of no markers, grouping or series", () => {
    const stored = params({
      marker: null,
      groupBy: null,
      series: [],
      axes: [],
    });
    expect(resolveParams(stored, table, samples)).toEqual(stored);
  });

  it("replaces what the log doesn't have, or is malformed, with defaults", () => {
    const resolved = resolveParams(
      {
        x: "gone",
        series: [{ set: "P(eval)", field: "nope", aggregation: "mean" }],
        marker: { set: "monitor", field: "log10_p" },
        messageBoundaries: "yes",
        groupBy: "p_eval",
        columns: 9,
      },
      table,
      samples
    );
    expect(resolved).toEqual(defaults);
  });

  it("puts each series stored before axes existed on its own axis, with its ends", () => {
    const { axes: _axes, ...stored } = params();
    const older = {
      ...stored,
      series: [
        { ...series("P(eval)", "p_eval"), axis: undefined, min: 0, max: 1 },
        { ...series("monitor", "log10_p"), axis: undefined },
        { ...series("monitor", "log10_p"), axis: undefined, max: 5 },
      ],
    };
    expect(resolveParams(older, table, samples)).toEqual(
      params({
        series: [
          series("P(eval)", "p_eval"),
          series("monitor", "log10_p", { axis: 1 }),
          series("monitor", "log10_p", { axis: 2 }),
        ],
        axes: [{ min: 0, max: 1 }, fitted, { min: null, max: 5 }],
      })
    );
  });

  it("renumbers stored axes in order of first use and fits missing ones", () => {
    const stored = params({
      series: [
        series("P(eval)", "p_eval", { axis: 2 }),
        series("monitor", "log10_p", { axis: 2 }),
        series("monitor", "log10_p", { axis: 0 }),
        series("monitor", "log10_p", { axis: 4 }),
      ],
      axes: [
        { min: 0, max: null },
        { min: 1, max: null },
        { min: 2, max: null },
      ],
    });
    expect(resolveParams(stored, table, samples)).toEqual({
      ...stored,
      series: [
        series("P(eval)", "p_eval", { axis: 0 }),
        series("monitor", "log10_p", { axis: 0 }),
        series("monitor", "log10_p", { axis: 1 }),
        series("monitor", "log10_p", { axis: 2 }),
      ],
      axes: [{ min: 2, max: null }, { min: 0, max: null }, fitted],
    });
  });

  it.each([
    [
      "a stored axis end that isn't a number",
      { axes: [{ min: "0", max: null }, fitted] },
    ],
    [
      "an axis end of the old shape that isn't a number",
      {
        axes: undefined,
        series: [{ ...series("P(eval)", "p_eval"), axis: undefined, min: "0" }],
      },
    ],
    ["axes that aren't a list", { axes: { min: 0 } }],
    [
      "a series axis that isn't an index",
      { series: [series("P(eval)", "p_eval", { axis: 1.5 })] },
    ],
    [
      "a series without an axis",
      { series: [{ ...series("P(eval)", "p_eval"), axis: undefined }] },
    ],
  ])("takes the default series and axes for %s", (_, changes) => {
    const resolved = resolveParams({ ...params(), ...changes }, table, samples);
    expect(resolved.series).toEqual(defaults.series);
    expect(resolved.axes).toEqual(defaults.axes);
  });

  it("uses the defaults for nothing stored", () => {
    expect(resolveParams(undefined, table, samples)).toEqual(defaults);
  });
});
