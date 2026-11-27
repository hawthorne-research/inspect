import { describe, expect, it } from "vitest";

import { alignedSets } from "./spanTable";
import { fixtureTable } from "./testFixtures";

describe("sampleSpanTable and mergeSpanTables", () => {
  it("describe every sample's sets, in the order first seen", () => {
    const { table } = fixtureTable([
      { epoch: 1, confidence: ["likely", "none", "none"] },
      { epoch: 2, pEval: [0.1, 0.2, 0.3], probes: [1, 2, 3, 4, 5, 6] },
    ]);
    expect(table.sets).toEqual([
      {
        name: "confidence",
        unit: "paragraph",
        scores: ["labels"],
        numeric: [],
        categorical: ["confidence"],
      },
      {
        name: "P(eval)",
        unit: "paragraph",
        scores: ["p_eval"],
        numeric: ["p_eval"],
        categorical: [],
      },
      {
        name: "probes",
        unit: "token",
        scores: ["probes"],
        numeric: ["deception"],
        categorical: [],
      },
    ]);
    expect(table.categoricalFields).toEqual({
      confidence: {
        confidence: {
          options: ["likely", "possible", "none"],
          negative: ["none"],
        },
      },
    });
    expect(table.rows).toHaveLength(3 + 3 + 6);
  });
});

describe("alignedSets", () => {
  it("has the sets with the x set's spans in every sample with both", () => {
    const { table } = fixtureTable([
      { epoch: 1, pEval: [0.1, 0.2, 0.3], log10: [-1, -2, -3] },
      {
        epoch: 2,
        pEval: [0.1, 0.2, 0.3],
        confidence: ["none", "none", "none"],
        probes: [1, 2, 3, 4, 5, 6],
      },
    ]);
    expect([...alignedSets(table.rows, "P(eval)")].sort()).toEqual([
      "P(eval)",
      "confidence",
      "monitor",
    ]);
    expect([...alignedSets(table.rows, "probes")]).toEqual(["probes"]);
  });

  it("leaves out a set that covers only some of the x set's spans", () => {
    const { table } = fixtureTable([
      {
        epoch: 1,
        pEval: [0.1, 0.2, 0.3],
        confidence: ["none", "none", "none"],
      },
    ]);
    const partial = table.rows.filter(
      (row) => row.annotation_set !== "confidence" || row.message_id === "a1"
    );
    expect([...alignedSets(partial, "P(eval)")]).toEqual(["P(eval)"]);
  });
});
