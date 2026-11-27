import { describe, expect, it } from "vitest";

import { testAssistantMessage } from "@tsmono/inspect-common/testing";

import {
  countOptions,
  optionColor,
  optionStyle,
  summaryOption,
} from "./categorical";
import type { CategoricalField } from "./format";
import { colorScheme, textOn, withAlpha, type Palette } from "./schemes";
import { kindField, rawLayer, rawPart, resolvedLayer } from "./testFixtures";

const field = (
  options: string[],
  negative: string[] = []
): CategoricalField => ({
  type: "categorical",
  name: "kind",
  description: null,
  metadata: {},
  options,
  negative,
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

describe("optionColor", () => {
  it("counts palette positions among the non-negative options only", () => {
    const leading = field(["none", "a", "b"], ["none"]);
    expect(optionColor(leading, "a", light)?.color).toBe(hue(0));
    expect(optionColor(leading, "b", light)?.color).toBe(hue(1));
    const middle = field(["a", "none", "b"], ["none"]);
    expect(optionColor(middle, "b", light)?.color).toBe(hue(1));
  });

  it("gives the found option of a two-option field the first hue", () => {
    const finding = field(["absent", "present"], ["absent"]);
    expect(optionColor(finding, "present", light)?.color).toBe(hue(0));
  });

  it("gives option names no meaning of their own", () => {
    const flag = field(["no", "yes"]);
    expect(optionColor(flag, "no", light)?.color).toBe(hue(0));
    expect(optionColor(flag, "yes", light)?.color).toBe(hue(1));
  });
});

describe("optionStyle", () => {
  it("tints by option position at the scheme's opacity, with readable text", () => {
    const kinds = field(["task_work", "mapping"]);
    expect(optionStyle(kinds, "task_work", [], light)).toEqual(tint(hue(0)));
    expect(optionStyle(kinds, "mapping", [], light)).toEqual(tint(hue(1)));
    expect(optionStyle(kinds, "task_work", [], light)).toEqual({
      backgroundColor: "rgba(42, 120, 214, 0.3)",
      color: "#000000",
    });
  });

  it.each([
    [["absent", "present"], ["absent"]],
    [["present", "absent"], ["absent"]],
    [["clean", "minor", "severe"], ["clean"]],
  ])("leaves negative options untinted in %j", (options, negative) => {
    const finding = field(options, negative);
    for (const option of negative) {
      expect(optionStyle(finding, option, [], light)).toBeUndefined();
    }
    const [first] = options.filter((o) => !negative.includes(o));
    expect(first && optionStyle(finding, first, [], light)).toEqual(
      tint(hue(0))
    );
  });

  it("reuses hues hatched past the eight-colour palette, counting non-negative options", () => {
    const many = field(
      ["none", ...Array.from({ length: 18 }, (_, i) => `o${i}`)],
      ["none"]
    );
    expect(optionStyle(many, "o7", [], light)).toEqual(tint(hue(7)));
    const hatched = optionStyle(many, "o9", [], light);
    expect(hatched?.backgroundColor).toBeUndefined();
    expect(hatched?.backgroundImage).toContain(withAlpha(hue(1), 0.3));
    expect(optionStyle(many, "o15", [], light)?.backgroundImage).toContain(
      withAlpha(hue(7), 0.3)
    );
    expect(optionStyle(many, "o16", [], light)).toEqual(tint(hues.none));
  });

  it("fades spans the highlight leaves out, tinted or not", () => {
    const finding = field(["absent", "present"], ["absent"]);
    expect(optionStyle(finding, "present", ["present"], light)).toEqual(
      tint(hue(0))
    );
    expect(optionStyle(finding, "absent", ["present"], light)).toEqual({
      opacity: 0.3,
    });
    expect(optionStyle(finding, undefined, ["present"], light)).toEqual({
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
    [["absent", "present"], "present", "absent"],
    [["yes", "no"], "yes", "no"],
    [["no", "yes"], "no", "yes"],
  ])(
    "passes over a negative option of %j unless nothing else is there",
    (options, found, negative) => {
      const finding = field(options, [negative]);
      expect(
        summaryOption(finding, [negative, negative, found, negative], [])
      ).toBe(found);
      expect(summaryOption(finding, [negative, negative], [])).toBe(negative);
    }
  );

  it("counts every option alike without negative options", () => {
    expect(summaryOption(field(["yes", "no"]), ["no", "no", "yes"], [])).toBe(
      "no"
    );
  });

  it("counts only highlighted options when some are there", () => {
    const labels = ["task_work", "task_work", "reporting"];
    expect(summaryOption(kinds, labels, ["reporting"])).toBe("reporting");
    expect(summaryOption(kinds, labels, ["mapping"])).toBe("task_work");
  });

  it("is undefined without labels", () => {
    expect(summaryOption(kinds, [], [])).toBeUndefined();
  });
});
