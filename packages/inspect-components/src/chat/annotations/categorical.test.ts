import { describe, expect, it } from "vitest";

import { testAssistantMessage } from "@tsmono/inspect-common/testing";

import { countOptions, optionStyle, summaryOption } from "./categorical";
import type { CategoricalField } from "./format";
import { colorScheme, textOn, withAlpha, type Palette } from "./schemes";
import { kindField, rawLayer, rawPart, resolvedLayer } from "./testFixtures";

const field = (options: string[], name = "kind"): CategoricalField => ({
  type: "categorical",
  name,
  description: null,
  modelLayer: null,
  options,
});

const light: Palette = { scheme: colorScheme("default"), dark: false };
const hues = light.scheme.light;

/** The default scheme's tint of `color` in the light theme. */
const tint = (color: string) => ({
  backgroundColor: withAlpha(color, 0.3),
  color: textOn(color, 0.3, false),
});

const hue = (index: number): string => {
  const color = hues.options[index];
  if (color === undefined) throw new Error(`no hue ${index}`);
  return color;
};

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
  it("tints by option index at the scheme's opacity, with readable text", () => {
    const kinds = field(["task_work", "mapping"]);
    expect(optionStyle(kinds, "task_work", [], light)).toEqual(tint(hue(0)));
    expect(optionStyle(kinds, "mapping", [], light)).toEqual(tint(hue(1)));
    expect(optionStyle(kinds, "task_work", [], light)).toEqual({
      backgroundColor: "rgba(42, 120, 214, 0.3)",
      color: "#000000",
    });
  });

  it.each([
    ["yes", "no", ["yes", "no"]],
    ["yes", "no", ["no", "yes"]],
    ["1", "0", ["1", "0"]],
    ["1", "0", ["0", "1"]],
  ])("tints %s strongly and leaves %s untinted in %j", (on, off, options) => {
    const flag = field(options);
    expect(optionStyle(flag, on, [], light)).toEqual(tint(hues.yes));
    expect(optionStyle(flag, off, [], light)).toBeUndefined();
  });

  it("tints other two-option fields by index", () => {
    const awareness = field(["no", "checking_work"]);
    expect(optionStyle(awareness, "no", [], light)).toEqual(tint(hue(0)));
  });

  it("reuses hues hatched past the eight-colour palette", () => {
    const many = field(Array.from({ length: 18 }, (_, i) => `o${i}`));
    expect(optionStyle(many, "o7", [], light)).toEqual(tint(hue(7)));
    const hatched = optionStyle(many, "o9", [], light);
    expect(hatched?.backgroundColor).toBeUndefined();
    expect(hatched?.backgroundImage).toContain(withAlpha(hue(1), 0.3));
    expect(optionStyle(many, "o17", [], light)).toEqual(tint(hues.none));
  });

  it("fades spans the highlight leaves out, tinted or not", () => {
    const flag = field(["yes", "no"]);
    expect(optionStyle(flag, "yes", ["yes"], light)).toEqual(tint(hues.yes));
    expect(optionStyle(flag, "no", ["yes"], light)).toEqual({ opacity: 0.3 });
    expect(optionStyle(flag, undefined, ["yes"], light)).toEqual({
      opacity: 0.3,
    });
  });

  it("follows the scheme: solid tints get white text on dark hues, black on light ones", () => {
    const saturated: Palette = {
      scheme: colorScheme("high-contrast-saturated"),
      dark: true,
    };
    const kinds = field(["blue", "red", "green", "gold"]);
    expect(optionStyle(kinds, "blue", [], saturated)).toEqual({
      backgroundColor: "rgba(0, 0, 255, 1)",
      color: "#ffffff",
    });
    expect(optionStyle(kinds, "gold", [], saturated)?.color).toBe("#000000");
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
