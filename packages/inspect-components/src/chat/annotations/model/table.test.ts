import { describe, expect, it } from "vitest";

import { normalizeEvalSample } from "@tsmono/inspect-common/normalize";
import {
  testAssistantMessage,
  testEvalSample,
  testSystemMessage,
  testUserMessage,
} from "@tsmono/inspect-common/testing";
import type { EvalSample, Score } from "@tsmono/inspect-common/types";

import demoSample from "./fixtures/demo-sample.json";
import demoSpans from "./fixtures/demo-spans.json";
import {
  alignSets,
  rollUp,
  spanRows,
  type Aggregation,
  type SetFields,
  type SpanRow,
  type SpanRowOptions,
} from "./table";
import {
  annotatedScore,
  kindField,
  probeField,
  rawPart,
  rawSet,
  suspectsField,
} from "./testFixtures";

const kSource = { evalId: "eval-1", log: "logs/maze.eval" };

// "Map it." and "Then go." are the reasoning's paragraphs.
const paragraphSet = (overrides: Record<string, unknown> = {}) =>
  rawSet({
    name: "paragraphs",
    unit: "paragraph",
    fields: [kindField, suspectsField],
    parts: [
      rawPart({
        message_id: "a1",
        content_index: 0,
        starts: [0, 9],
        ends: [7, 17],
        values: {
          kind: ["mapping", "task_work"],
          suspects_test: ["no", "yes"],
        },
        probabilities: {
          suspects_test: [
            [0.25, 0.75],
            [1, 0],
          ],
        },
      }),
    ],
    ...overrides,
  });

const tokenSet = rawSet({
  parts: [
    rawPart({
      starts: [0, 2, 5],
      ends: [1, 4, 10],
      values: { deception: [0.5, -1, 2] },
    }),
  ],
});

const sampleWith = (
  scores: Record<string, Score>,
  uuid = "uuid-1"
): EvalSample =>
  testEvalSample({
    uuid,
    id: "maze-1",
    epoch: 2,
    messages: [
      testSystemMessage({ id: "s1", content: "Be brief." }),
      testUserMessage({ id: "u1", content: "🧭 Go north" }),
      testAssistantMessage({
        id: "a1",
        content: [
          {
            type: "reasoning",
            reasoning: "Map it.\n\nThen go.",
            redacted: false,
          },
          {
            type: "text",
            text: "Done.",
            refusal: null,
            internal: null,
            citations: null,
          },
        ],
      }),
    ],
    scores,
  });

const kSample = sampleWith({
  labels: annotatedScore([paragraphSet()]),
  probes: annotatedScore([tokenSet]),
});

const rowsOf = (sample: EvalSample, options: SpanRowOptions = {}) => {
  const { rows, errors } = spanRows(sample, kSource, options);
  expect(errors).toEqual([]);
  return rows;
};

describe("spanRows", () => {
  it("has a row per span with every column, in set then transcript order", () => {
    const keys = {
      sample_id: "uuid-1",
      eval_id: "eval-1",
      log: "logs/maze.eval",
      id: "maze-1",
      epoch: 2,
    };
    const paragraph = {
      ...keys,
      score: "labels",
      annotation_set: "paragraphs",
      unit: "paragraph",
      message_id: "a1",
      message_index: 2,
      role: "assistant",
      content_index: 0,
      field_deception: null,
    };
    const token = {
      ...keys,
      score: "probes",
      annotation_set: "probes",
      unit: "token",
      message_id: "u1",
      message_index: 1,
      role: "user",
      content_index: null,
      field_kind: null,
      field_suspects_test: null,
      prob_suspects_test_yes: null,
      prob_suspects_test_no: null,
    };
    expect(rowsOf(kSample, { text: true, probabilities: true })).toEqual([
      {
        ...paragraph,
        start: 0,
        end: 7,
        span_index: 0,
        text: "Map it.",
        field_kind: "mapping",
        field_suspects_test: "no",
        prob_suspects_test_yes: 0.25,
        prob_suspects_test_no: 0.75,
      },
      {
        ...paragraph,
        start: 9,
        end: 17,
        span_index: 1,
        text: "Then go.",
        field_kind: "task_work",
        field_suspects_test: "yes",
        prob_suspects_test_yes: 1,
        prob_suspects_test_no: 0,
      },
      {
        ...token,
        start: 0,
        end: 1,
        span_index: 0,
        text: "🧭",
        field_deception: 0.5,
      },
      {
        ...token,
        start: 2,
        end: 4,
        span_index: 1,
        text: "Go",
        field_deception: -1,
      },
      {
        ...token,
        start: 5,
        end: 10,
        span_index: 2,
        text: "north",
        field_deception: 2,
      },
    ]);
  });

  it("numbers a set's spans across its parts", () => {
    const sample = sampleWith({
      labels: annotatedScore([
        paragraphSet({
          parts: [
            rawPart({
              message_id: "u1",
              starts: [0, 5],
              ends: [4, 10],
              values: {
                kind: ["mapping", "mapping"],
                suspects_test: ["no", "no"],
              },
            }),
            rawPart({
              message_id: "a1",
              content_index: 1,
              starts: [0],
              ends: [5],
              values: { kind: ["task_work"], suspects_test: ["no"] },
            }),
          ],
        }),
      ]),
    });
    expect(
      rowsOf(sample).map((r) => [
        r.span_index,
        r.message_index,
        r.content_index,
      ])
    ).toEqual([
      [0, 1, null],
      [1, 1, null],
      [2, 2, 1],
    ]);
  });

  it("gives the sample's id as a string, as samples_df does", () => {
    const [row] = rowsOf({ ...kSample, id: 7 });
    expect(row?.id).toBe("7");
  });

  it("leaves out text and probabilities unless asked for", () => {
    const [row] = rowsOf(kSample);
    expect(row).toBeDefined();
    expect(Object.keys(row ?? {}).filter(isOptionalColumn)).toEqual([]);
  });

  it("leaves out probability columns of fields without probabilities", () => {
    const sample = sampleWith({
      labels: annotatedScore([
        paragraphSet({
          parts: [
            rawPart({
              message_id: "a1",
              content_index: 1,
              starts: [0],
              ends: [5],
              values: { kind: ["task_work"], suspects_test: ["no"] },
            }),
          ],
        }),
      ]),
    });
    const [row] = rowsOf(sample, { probabilities: true });
    expect(Object.keys(row ?? {}).filter(isOptionalColumn)).toEqual([]);
  });

  it("includes only the sets asked for, and only their columns", () => {
    const rows = rowsOf(kSample, { sets: ["probes"] });
    expect(rows.map((r) => r.annotation_set)).toEqual([
      "probes",
      "probes",
      "probes",
    ]);
    expect(Object.keys(rows[0] ?? {}).filter(isFieldColumn)).toEqual([
      "field_deception",
    ]);
  });

  it("gives the options of the sets' categorical fields", () => {
    expect(spanRows(kSample, kSource).categoricalFields).toEqual({
      paragraphs: {
        kind: { options: kindField.options, negative: [] },
        suspects_test: { options: ["yes", "no"], negative: ["no"] },
      },
    });
  });

  it("returns the errors of invalid sets with the other sets' rows", () => {
    const { rows, errors } = spanRows(
      sampleWith({
        labels: annotatedScore([
          paragraphSet({
            parts: [
              rawPart({
                message_id: "gone",
                values: { kind: ["mapping"], suspects_test: ["no"] },
                starts: [0],
                ends: [1],
              }),
            ],
          }),
        ]),
        probes: annotatedScore([tokenSet]),
      }),
      kSource
    );
    expect(errors).toEqual([expect.stringMatching(/gone not found/)]);
    expect(rows.map((r) => r.annotation_set)).toEqual([
      "probes",
      "probes",
      "probes",
    ]);
  });
});

const isFieldColumn = (key: string): boolean => key.startsWith("field_");

const isOptionalColumn = (key: string): boolean =>
  key === "text" || key.startsWith("prob_");

const fieldAndProbabilityColumns = (row: SpanRow | undefined): string[] =>
  Object.keys(row ?? {})
    .filter((key) => isFieldColumn(key) || key.startsWith("prob_"))
    .sort();

// The user's message, the two reasoning paragraphs and the text part.
const coarseSet = rawSet({
  name: "paragraphs",
  unit: "paragraph",
  fields: [kindField],
  parts: [
    rawPart({
      message_id: "u1",
      starts: [0],
      ends: [10],
      values: { kind: ["mapping"] },
    }),
    rawPart({
      message_id: "a1",
      content_index: 0,
      starts: [0, 9],
      ends: [7, 17],
      values: { kind: ["mapping", "task_work"] },
    }),
    rawPart({
      message_id: "a1",
      content_index: 1,
      starts: [0],
      ends: [5],
      values: { kind: ["task_work"] },
    }),
  ],
});

// Has the reasoning's paragraphs and the gap between them, and no unit.
const judgeSet = rawSet({
  name: "judge",
  unit: undefined,
  fields: [
    { name: "confidence", type: "numeric" },
    { name: "verdict", type: "categorical", options: ["ok", "bad"] },
  ],
  parts: [
    rawPart({
      message_id: "a1",
      content_index: 0,
      starts: [0, 7, 9],
      ends: [7, 9, 17],
      values: { confidence: [0.9, 0.1, 0.4], verdict: ["ok", "ok", "bad"] },
      probabilities: {
        verdict: [
          [0.75, 0.25],
          [0.5, 0.5],
          [0, 1],
        ],
      },
    }),
  ],
});

describe("alignSets", () => {
  const scores = {
    labels: annotatedScore([coarseSet]),
    judges: annotatedScore([judgeSet]),
    probes: annotatedScore([tokenSet]),
  };
  const rows = [
    ...rowsOf(sampleWith(scores, "uuid-1"), { probabilities: true }),
    ...rowsOf(sampleWith(scores, "uuid-2"), { probabilities: true }),
  ];
  const summary = (r: SpanRow) => ({
    sample_id: r.sample_id,
    score: r.score,
    annotation_set: r.annotation_set,
    unit: r.unit,
    start: r.start,
    end: r.end,
    span_index: r.span_index,
    kind: r.field_kind,
    confidence: r.field_confidence,
    verdict: r.field_verdict,
    ok: r.prob_verdict_ok,
  });
  const alignedSpans = (sample_id: string) => [
    {
      sample_id,
      score: "labels+judges",
      annotation_set: "paragraphs+judge",
      unit: "paragraph",
      start: 0,
      end: 7,
      span_index: 0,
      kind: "mapping",
      confidence: 0.9,
      verdict: "ok",
      ok: 0.75,
    },
    {
      sample_id,
      score: "labels+judges",
      annotation_set: "paragraphs+judge",
      unit: "paragraph",
      start: 9,
      end: 17,
      span_index: 1,
      kind: "task_work",
      confidence: 0.4,
      verdict: "bad",
      ok: 0,
    },
  ];

  it("keeps the spans every set has, with their fields merged", () => {
    expect(alignSets(rows, ["paragraphs", "judge"]).map(summary)).toEqual([
      ...alignedSpans("uuid-1"),
      ...alignedSpans("uuid-2"),
    ]);
  });

  it("leaves out units that are null, and has none if no set has one", () => {
    const judge = rows.filter((r) => r.annotation_set === "judge");
    expect(new Set(judge.map((r) => r.unit))).toEqual(new Set([null]));
    expect(new Set(alignSets(rows, ["judge"]).map((r) => r.unit))).toEqual(
      new Set([null])
    );
  });

  it("keeps only the aligned sets' field columns", () => {
    const [row] = alignSets(rows, ["paragraphs", "judge"]);
    expect(fieldAndProbabilityColumns(row)).toEqual([
      "field_confidence",
      "field_kind",
      "field_verdict",
      "prob_verdict_bad",
      "prob_verdict_ok",
    ]);
  });

  it("puts each sample's spans in transcript order, samples as they first appear", () => {
    expect(
      alignSets([...rows].reverse(), ["paragraphs", "judge"]).map(summary)
    ).toEqual([...alignedSpans("uuid-2"), ...alignedSpans("uuid-1")]);
  });

  it.each<[string, readonly string[], readonly SpanRow[], RegExp]>([
    ["no sets", [], rows, /No annotation sets/],
    ["a repeated set", ["judge", "judge"], rows, /repeated/],
    [
      "a set without rows",
      ["paragraphs", "gone"],
      rows,
      /No spans of annotation set "gone"/,
    ],
    [
      "a sample twice",
      ["paragraphs", "judge"],
      [...rows, ...rows],
      /more than one span/,
    ],
  ])("rejects %s", (_name, sets, input, error) => {
    expect(() => alignSets(input, sets)).toThrow(error);
  });

  it("rejects sets that share a field name", () => {
    const clashing = rowsOf(
      sampleWith({
        labels: annotatedScore([coarseSet]),
        other: annotatedScore([
          rawSet({ ...coarseSet, name: "more paragraphs" }),
        ]),
      })
    );
    expect(() =>
      alignSets(clashing, ["paragraphs", "more paragraphs"])
    ).toThrow(/fields "kind"/);
  });
});

describe("rollUp", () => {
  const cueField = {
    name: "cue",
    type: "categorical",
    options: ["grader", "user", "none"],
    negative: ["none"],
  };
  // "Map", "it", "." | "Then", "go", "." in the reasoning; "Done", "." in
  // the text part, whose offsets also fall inside "Map it.".
  const fineSet = (cue: readonly string[]) =>
    rawSet({
      name: "tokens",
      unit: "token",
      fields: [probeField, cueField],
      parts: [
        rawPart({
          message_id: "a1",
          content_index: 0,
          starts: [0, 4, 6, 9, 14, 16],
          ends: [3, 6, 7, 13, 16, 17],
          values: { deception: [1, 3, 5, -2, 4, 1], cue },
        }),
        rawPart({
          message_id: "a1",
          content_index: 1,
          starts: [0, 4],
          ends: [4, 5],
          values: { deception: [10, 20], cue: ["none", "none"] },
        }),
      ],
    });
  const table = (cue: readonly string[]) =>
    spanRows(
      sampleWith({
        labels: annotatedScore([coarseSet]),
        judges: annotatedScore([judgeSet]),
        probes: annotatedScore([fineSet(cue)]),
      }),
      kSource,
      { probabilities: true }
    );
  const kCue = ["none", "user", "none", "user", "grader", "user"];
  const { rows, categoricalFields } = table(kCue);
  const rolled = (agg: Aggregation): SpanRow[] =>
    rollUp(rows, "tokens", "paragraphs", agg, categoricalFields);

  it("keeps the coarse set's rows and columns, with the fine set's fields", () => {
    const result = rolled("mean");
    expect(
      result.map((r) => [r.annotation_set, r.span_index, r.field_kind])
    ).toEqual([
      ["paragraphs", 0, "mapping"],
      ["paragraphs", 1, "mapping"],
      ["paragraphs", 2, "task_work"],
      ["paragraphs", 3, "task_work"],
    ]);
    expect(fieldAndProbabilityColumns(result[0])).toEqual([
      "field_cue",
      "field_deception",
      "field_kind",
    ]);
  });

  // Paragraphs in transcript order: the user's message (no tokens), "Map
  // it.", "Then go.", then the text part "Done.".
  it.each<[Aggregation, (number | null)[]]>([
    ["mean", [null, 3, 1, 15]],
    ["max", [null, 5, 4, 20]],
    ["min", [null, 1, -2, 10]],
    ["sum", [0, 9, 3, 30]],
    ["count", [0, 3, 3, 2]],
  ])(
    "aggregates numeric fields over contained spans with %s",
    (agg, expected) => {
      expect(rolled(agg).map((r) => r.field_deception)).toEqual(expected);
    }
  );

  it("takes the most frequent option, passing over negative ones unless nothing else is there", () => {
    expect(rolled("mean").map((r) => r.field_cue)).toEqual([
      null,
      "user",
      "user",
      "none",
    ]);
  });

  it("breaks ties by the field's option order", () => {
    const tied = table(["none", "user", "none", "user", "grader", "none"]);
    expect(
      rollUp(
        tied.rows,
        "tokens",
        "paragraphs",
        "mean",
        tied.categoricalFields
      ).map((r) => r.field_cue)
    ).toEqual([null, "user", "grader", "none"]);
  });

  it("rejects a categorical field without its options", () => {
    const fields: SetFields = { tokens: {} };
    expect(() => rollUp(rows, "tokens", "paragraphs", "sum", fields)).toThrow(
      /options of field "cue"/
    );
  });

  it("rejects rolling a set into itself or a missing one", () => {
    expect(() => rollUp(rows, "paragraphs", "paragraphs", "sum")).toThrow(
      /into itself/
    );
    expect(() =>
      rollUp(rows, "tokens", "gone", "sum", categoricalFields)
    ).toThrow(/No spans of annotation set "gone"/);
  });

  it("rejects sets that share a field name", () => {
    const clashing = rowsOf(
      sampleWith({
        labels: annotatedScore([coarseSet]),
        probes: annotatedScore([
          rawSet({
            name: "tokens",
            fields: [kindField],
            parts: [
              rawPart({
                message_id: "a1",
                content_index: 0,
                starts: [0],
                ends: [3],
                values: { kind: ["mapping"] },
              }),
            ],
          }),
        ]),
      })
    );
    expect(() => rollUp(clashing, "tokens", "paragraphs", "sum")).toThrow(
      /fields "kind"/
    );
  });
});

// The fixtures are written by Python (proto/text_annotations/examples/
// make_table_fixture.py): a demo sample and `spans_df`'s rows for it.
describe("spanRows matches Python's spans_df", () => {
  it("builds the same rows for the demo sample", () => {
    const { header, sample } = demoSample;
    const { rows, errors } = spanRows(
      normalizeEvalSample(sample),
      { evalId: header.eval_id, log: header.log },
      { text: true, probabilities: true }
    );
    expect(errors).toEqual([]);
    expect(rows).toEqual(demoSpans);
  });
});
