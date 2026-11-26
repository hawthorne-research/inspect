import { describe, expect, it } from "vitest";

import { testAssistantMessage } from "@tsmono/inspect-common/testing";

import { countOptions, optionStyle, summaryOption } from "./categorical";
import type { CategoricalField } from "./format";
import { kindField, rawLayer, rawPart, resolvedLayer } from "./testFixtures";

const field = (options: string[], name = "kind"): CategoricalField => ({
  type: "categorical",
  name,
  description: null,
  modelLayer: null,
  options,
});

const tint = (color: string) =>
  `color-mix(in srgb, var(--inspect-annotation-${color}) 30%, transparent)`;

describe("countOptions", () => {
  it("counts each option across parts, in option order", () => {
    const messages = [
      testAssistantMessage({ id: "a1", content: "One. Two." }),
      testAssistantMessage({ id: "a2", content: "Three." }),
    ];
    const layer = resolvedLayer(
      rawLayer({
        fields: [kindField],
        parts: [
          rawPart({
            message_id: "a1",
            starts: [0, 5],
            ends: [4, 9],
            values: { kind: ["mapping", "mapping"] },
          }),
          rawPart({
            message_id: "a2",
            starts: [0],
            ends: [6],
            values: { kind: ["mapping"] },
          }),
        ],
      }),
      messages
    );
    expect(countOptions(layer, field(["task_work", "mapping"]))).toEqual([
      { option: "task_work", count: 0 },
      { option: "mapping", count: 3 },
    ]);
  });
});

describe("optionStyle", () => {
  it("tints by option index at a fixed opacity", () => {
    const kinds = field(["task_work", "mapping"]);
    expect(optionStyle(kinds, "task_work", [])).toEqual({
      backgroundColor: tint("option-1"),
    });
    expect(optionStyle(kinds, "mapping", [])).toEqual({
      backgroundColor: tint("option-2"),
    });
  });

  it.each([
    ["yes", "no", ["yes", "no"]],
    ["yes", "no", ["no", "yes"]],
    ["1", "0", ["1", "0"]],
    ["1", "0", ["0", "1"]],
  ])("tints %s strongly and leaves %s untinted in %j", (on, off, options) => {
    const flag = field(options);
    expect(optionStyle(flag, on, [])).toEqual({
      backgroundColor: tint("option-yes"),
    });
    expect(optionStyle(flag, off, [])).toBeUndefined();
  });

  it("tints other two-option fields by index", () => {
    const awareness = field(["no", "checking_work"]);
    expect(optionStyle(awareness, "no", [])).toEqual({
      backgroundColor: tint("option-1"),
    });
  });

  it("reuses hues hatched past the eight-colour palette", () => {
    const many = field(Array.from({ length: 18 }, (_, i) => `o${i}`));
    expect(optionStyle(many, "o7", [])).toEqual({
      backgroundColor: tint("option-8"),
    });
    const hatched = optionStyle(many, "o9", []);
    expect(hatched?.backgroundColor).toBeUndefined();
    expect(hatched?.backgroundImage).toContain(
      "var(--inspect-annotation-option-2)"
    );
    expect(optionStyle(many, "o17", [])).toEqual({
      backgroundColor: tint("option-none"),
    });
  });

  it("fades spans the highlight leaves out, tinted or not", () => {
    const flag = field(["yes", "no"]);
    expect(optionStyle(flag, "yes", ["yes"])).toEqual({
      backgroundColor: tint("option-yes"),
    });
    expect(optionStyle(flag, "no", ["yes"])).toEqual({ opacity: 0.3 });
    expect(optionStyle(flag, undefined, ["yes"])).toEqual({ opacity: 0.3 });
  });
});

describe("summaryOption", () => {
  const kinds = field(["task_work", "mapping", "reporting"]);

  it("is the most frequent option", () => {
    expect(summaryOption(kinds, ["task_work", "mapping", "mapping"], [])).toBe(
      "mapping"
    );
  });

  it("breaks ties by option order", () => {
    expect(summaryOption(kinds, ["reporting", "mapping"], [])).toBe("mapping");
  });

  it.each([
    [["yes", "no"], "yes", "no"],
    [["1", "0"], "1", "0"],
  ])(
    "passes over the untinted option of %j unless nothing else is there",
    (options, on, off) => {
      const flag = field(options);
      expect(summaryOption(flag, [off, off, on, off], [])).toBe(on);
      expect(summaryOption(flag, [off, off], [])).toBe(off);
    }
  );

  it("counts only highlighted options when some are there", () => {
    const labels = ["task_work", "task_work", "reporting"];
    expect(summaryOption(kinds, labels, ["reporting"])).toBe("reporting");
    expect(summaryOption(kinds, labels, ["mapping"])).toBe("task_work");
  });

  it("is undefined without labels", () => {
    expect(summaryOption(kinds, [], [])).toBeUndefined();
  });
});
