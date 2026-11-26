import { describe, expect, it } from "vitest";

import { testAssistantMessage } from "@tsmono/inspect-common/testing";

import { countOptions, isDimmed, labelText, optionMark } from "./categorical";
import type { CategoricalField } from "./format";
import { kindField, rawLayer, rawPart, resolvedLayer } from "./testFixtures";

const field = (options: string[], name = "kind"): CategoricalField => ({
  type: "categorical",
  name,
  description: null,
  options,
});

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

describe("optionMark", () => {
  it("colours by option index, with yes/no as strong/neutral", () => {
    expect(optionMark(field(["task_work", "mapping"]), "mapping")).toEqual({
      color: "var(--inspect-annotation-option-2)",
      hollow: false,
    });
    const yesNo = field(["yes", "no"]);
    expect(optionMark(yesNo, "yes").color).toBe(
      "var(--inspect-annotation-option-yes)"
    );
    expect(optionMark(yesNo, "no").color).toBe(
      "var(--inspect-annotation-option-none)"
    );
  });

  it("reuses hues hollow past the eight-colour palette", () => {
    const many = field(Array.from({ length: 11 }, (_, i) => `o${i}`));
    expect(optionMark(many, "o7")).toEqual({
      color: "var(--inspect-annotation-option-8)",
      hollow: false,
    });
    expect(optionMark(many, "o9")).toEqual({
      color: "var(--inspect-annotation-option-2)",
      hollow: true,
    });
  });
});

describe("labelText", () => {
  it("names the field on bare yes/no labels", () => {
    const awareness = field(["no", "checking_work"], "test_awareness");
    expect(labelText(awareness, "no")).toBe("test_awareness: no");
    expect(labelText(awareness, "checking_work")).toBe("checking_work");
  });
});

describe("isDimmed", () => {
  it("dims nothing without a highlight", () => {
    expect(isDimmed([], "mapping")).toBe(false);
  });

  it("dims spans whose label is not highlighted", () => {
    expect(isDimmed(["mapping"], "mapping")).toBe(false);
    expect(isDimmed(["task_work"], "mapping")).toBe(true);
    expect(isDimmed(["task_work"], undefined)).toBe(true);
  });
});
