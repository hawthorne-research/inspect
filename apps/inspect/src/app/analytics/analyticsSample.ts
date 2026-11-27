import type { AnalyticsSample } from "@tsmono/inspect-components/analytics/model";

import type { EvalSampleScore } from "../../@types/extraInspect";

/** A sample, or its summary, as analytics see it: its identity and score
 *  values. */
export const analyticsSample = (sample: {
  id: string | number;
  epoch: number;
  scores?: EvalSampleScore;
}): AnalyticsSample => ({
  id: sample.id,
  epoch: sample.epoch,
  scores: Object.fromEntries(
    Object.entries(sample.scores ?? {}).map(([name, score]) => [
      name,
      score.value,
    ])
  ),
});
