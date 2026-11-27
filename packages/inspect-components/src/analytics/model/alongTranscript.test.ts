import { describe, expect, it } from "vitest";

import { layerId } from "../../chat/annotations/model";

import {
  alongTranscript,
  defaultParams,
  resolveParams,
  type AlongTranscriptParams,
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
  layer: string,
  field: string,
  overrides: Partial<SeriesParams> = {}
): SeriesParams => ({
  layer,
  field,
  aggregation: "mean",
  reference: null,
  min: null,
  max: null,
  ...overrides,
});

const params = (
  overrides: Partial<AlongTranscriptParams> = {}
): AlongTranscriptParams => ({
  x: "P(eval)",
  series: [series("P(eval)", "p_eval"), series("monitor", "log10_p")],
  marker: { layer: "confidence", field: "confidence" },
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
    // Without the monitor's layer.
    { ...full(4, "grader"), log10: undefined },
    full(1, "grader"),
  ]);

  it("has a panel per sample with every chosen layer, grouped by score, then by epoch", () => {
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

  it("keeps samples without a layer nothing asks for", () => {
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

  it("puts the x layer's spans at 1, 2, ... with each series' value on them", () => {
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

  it("tells where each point's span is, and which layer it is of", () => {
    const [panel] = panels(alongTranscript(table, samples, params()));
    expect(panel?.layerId).toBe(layerId("p_eval", "P(eval)"));
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
    "rolls a finer layer's field up onto the x spans by its %s",
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

  it("joins a layer with the x layer's spans without rolling it up", () => {
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

  it("gives each series a nice domain shared by every panel, with its reference", () => {
    const view = alongTranscript(
      table,
      samples,
      params({
        series: [
          series("P(eval)", "p_eval", { reference: 0.5 }),
          series("monitor", "log10_p", { reference: -20 }),
        ],
      })
    );
    expect(view.series.map((s) => s.domain)).toEqual([
      [0.2, 0.9],
      [-20, 0],
    ]);
    expect(view.yDomain).toEqual([0.2, 0.9]);
  });

  it("fixes the axis ends a series sets, and fits the others to the data", () => {
    const view = alongTranscript(
      table,
      samples,
      params({
        series: [
          series("P(eval)", "p_eval", { min: 0, max: 1 }),
          series("monitor", "log10_p", { max: 5 }),
        ],
      })
    );
    expect(view.series.map((s) => s.domain)).toEqual([
      [0, 1],
      [-12, 5],
    ]);
    expect(view.yDomain).toEqual([0, 1]);
  });

  it("ignores fixed ends that leave no range", () => {
    const fitted = alongTranscript(table, samples, params());
    const view = alongTranscript(
      table,
      samples,
      params({
        series: [
          series("P(eval)", "p_eval", { min: 1, max: 0 }),
          series("monitor", "log10_p", { min: 50 }),
        ],
      })
    );
    expect(view.series.map((s) => s.domain)).toEqual(
      fitted.series.map((s) => s.domain)
    );
  });

  it("maps the second series onto the first series' axis, and back", () => {
    const view = alongTranscript(table, samples, params());
    const [left, right] = view.series;
    const map = view.rightAxis;
    if (!left || !right || !map) throw new Error("expected two series");
    expect(map.forward(right.domain[0])).toBeCloseTo(left.domain[0], 10);
    expect(map.forward(right.domain[1])).toBeCloseTo(left.domain[1], 10);
    for (const value of [-12, -6, -3, right.ticks[1] ?? 0]) {
      expect(map.inverse(map.forward(value))).toBeCloseTo(value, 10);
    }
    const single = alongTranscript(
      table,
      samples,
      params({ series: [series("P(eval)", "p_eval")] })
    );
    expect(single.rightAxis).toBeNull();
  });

  it("has no panels when no sample has the x layer", () => {
    const view = alongTranscript(
      table,
      samples,
      params({ x: "gone", series: [], marker: null })
    );
    expect(panels(view)).toEqual([]);
    expect(view.omitted).toBe(4);
  });
});

describe("defaultParams", () => {
  it("starts from the first numeric layer, aligned markers and the one sample score", () => {
    const { table, samples } = fixtureTable([
      { epoch: 1, outcome: "user", confidence: ["none", "none", "likely"] },
      full(2, "grader"),
    ]);
    expect(defaultParams(table, samples)).toEqual({
      x: "P(eval)",
      series: [series("P(eval)", "p_eval")],
      marker: { layer: "confidence", field: "confidence" },
      messageBoundaries: true,
      groupBy: "outcome",
      columns: 2,
    });
  });

  it("doesn't mark with a layer of other spans", () => {
    const { table, samples } = fixtureTable([
      { epoch: 1, pEval: [1, 2, 3], probes: [1, 2, 3, 4, 5, 6] },
    ]);
    const defaults = defaultParams(table, samples);
    expect(defaults.marker).toBeNull();
    expect(defaults.groupBy).toBeNull();
  });
});

describe("resolveParams", () => {
  const { table, samples } = fixtureTable([full(1, "grader")]);
  const defaults = defaultParams(table, samples);

  it("keeps stored parameters the log has", () => {
    const stored = params({ x: "monitor", columns: 3 });
    expect(resolveParams(stored, table, samples)).toEqual(stored);
  });

  it("keeps an explicit choice of no markers or grouping", () => {
    const stored = params({ marker: null, groupBy: null, series: [] });
    expect(resolveParams(stored, table, samples)).toEqual(stored);
  });

  it("replaces what the log doesn't have, or is malformed, with defaults", () => {
    const resolved = resolveParams(
      {
        x: "gone",
        series: [{ layer: "P(eval)", field: "nope", aggregation: "mean" }],
        marker: { layer: "monitor", field: "log10_p" },
        messageBoundaries: "yes",
        groupBy: "p_eval",
        columns: 9,
      },
      table,
      samples
    );
    expect(resolved).toEqual(defaults);
  });

  it("reads stored series without axis ends as fitting both ends", () => {
    const stored = params();
    const older = {
      ...stored,
      series: stored.series.map(({ min: _min, max: _max, ...rest }) => rest),
    };
    expect(resolveParams(older, table, samples)).toEqual(stored);
  });

  it("rejects stored axis ends that aren't numbers", () => {
    const stored = params();
    const bad = {
      ...stored,
      series: stored.series.map((s) => ({ ...s, min: "0" })),
    };
    expect(resolveParams(bad, table, samples)).toEqual(defaults);
  });

  it("uses the defaults for nothing stored", () => {
    expect(resolveParams(undefined, table, samples)).toEqual(defaults);
  });
});
