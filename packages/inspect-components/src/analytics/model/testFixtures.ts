import {
  testAssistantMessage,
  testEvalSample,
  testScore,
  testUserMessage,
} from "@tsmono/inspect-common/testing";
import type { EvalSample, Score } from "@tsmono/inspect-common/types";

import {
  annotatedScore,
  rawPart,
  rawSet,
} from "../../chat/annotations/model/testFixtures";

import type { AnalyticsSample } from "./alongTranscript";
import { mergeSpanTables, sampleSpanTable, type SpanTable } from "./spanTable";

// A sample of three paragraphs, "Para one." and "Para two." in message a1
// and "Para three." in a2, with two tokens each.

const paragraphParts = (values: Record<string, readonly unknown[]>) => [
  rawPart({
    message_id: "a1",
    starts: [0, 11],
    ends: [9, 20],
    values: Object.fromEntries(
      Object.entries(values).map(([name, v]) => [name, v.slice(0, 2)])
    ),
  }),
  rawPart({
    message_id: "a2",
    starts: [0],
    ends: [11],
    values: Object.fromEntries(
      Object.entries(values).map(([name, v]) => [name, v.slice(2)])
    ),
  }),
];

const numericField = (name: string) => ({
  name,
  description: null,
  type: "numeric",
});

export const kConfidenceField = {
  name: "confidence",
  description: null,
  type: "categorical",
  options: ["likely", "possible", "none"],
  negative: ["none"],
};

export interface FixtureSample {
  id?: string;
  epoch: number;
  outcome?: string;
  pEval?: readonly number[];
  log10?: readonly number[];
  confidence?: readonly string[];
  /** Per token: a1 has four, a2 two. */
  probes?: readonly number[];
  /** The unit of the sets on paragraphs; "paragraph" by default. */
  paragraphUnit?: string | null;
}

/** A sample with the annotation sets given: "P(eval)", "monitor" and
 *  "confidence" on its paragraphs, "probes" on its tokens, and an "outcome"
 *  score. */
export const fixtureSample = ({
  id = "maze",
  epoch,
  outcome,
  pEval,
  log10,
  confidence,
  probes,
  paragraphUnit = "paragraph",
}: FixtureSample): EvalSample => {
  const scores: Record<string, Score> = {};
  if (outcome !== undefined) scores["outcome"] = testScore({ value: outcome });
  if (pEval) {
    scores["p_eval"] = annotatedScore([
      rawSet({
        name: "P(eval)",
        unit: paragraphUnit,
        fields: [numericField("p_eval")],
        parts: paragraphParts({ p_eval: pEval }),
      }),
    ]);
  }
  if (log10) {
    scores["monitor"] = annotatedScore([
      rawSet({
        name: "monitor",
        unit: paragraphUnit,
        fields: [numericField("log10_p")],
        parts: paragraphParts({ log10_p: log10 }),
      }),
    ]);
  }
  if (confidence) {
    scores["labels"] = annotatedScore([
      rawSet({
        name: "confidence",
        unit: paragraphUnit,
        fields: [kConfidenceField],
        parts: paragraphParts({ confidence }),
      }),
    ]);
  }
  if (probes) {
    scores["probes"] = annotatedScore([
      rawSet({
        name: "probes",
        unit: "token",
        fields: [numericField("deception")],
        parts: [
          rawPart({
            message_id: "a1",
            starts: [0, 5, 11, 16],
            ends: [4, 9, 15, 20],
            values: { deception: probes.slice(0, 4) },
          }),
          rawPart({
            message_id: "a2",
            starts: [0, 5],
            ends: [4, 11],
            values: { deception: probes.slice(4) },
          }),
        ],
      }),
    ]);
  }
  return testEvalSample({
    id,
    epoch,
    messages: [
      testUserMessage({ id: "u1", content: "Go." }),
      testAssistantMessage({ id: "a1", content: "Para one.\n\nPara two." }),
      testUserMessage({ id: "u2", content: "And?" }),
      testAssistantMessage({ id: "a2", content: "Para three." }),
    ],
    scores,
  });
};

/** The span table of `samples` and their sample-list entries. */
export const fixtureTable = (
  samples: readonly FixtureSample[]
): { table: SpanTable; samples: AnalyticsSample[] } => {
  const evalSamples = samples.map(fixtureSample);
  const tables = evalSamples.map((sample) => {
    const table = sampleSpanTable(sample, {
      evalId: "eval-1",
      log: "logs/maze.eval",
    });
    if (table.errors.length > 0) throw new Error(table.errors.join("; "));
    return table;
  });
  return {
    table: mergeSpanTables(tables),
    samples: evalSamples.map((sample) => ({
      id: sample.id,
      epoch: sample.epoch,
      scores: Object.fromEntries(
        Object.entries(sample.scores ?? {}).map(([name, score]) => [
          name,
          score.value,
        ])
      ),
    })),
  };
};
