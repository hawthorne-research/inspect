import { FC } from "react";

import type { EvalSample } from "@tsmono/inspect-common/types";
import { sampleSpanTable } from "@tsmono/inspect-components/analytics/model";

import { AlongTranscriptSection } from "./AlongTranscriptSection";
import styles from "./Analytics.module.css";
import { analyticsSample } from "./analyticsSample";

interface SampleAnalyticsProps {
  sample: EvalSample;
  evalId: string;
  logFile: string;
}

/** A sample's Analytics tab: the log's Analytics views of this sample
 *  alone. */
export const SampleAnalytics: FC<SampleAnalyticsProps> = ({
  sample,
  evalId,
  logFile,
}) => {
  const table = sampleSpanTable(sample, { evalId, log: logFile });
  return (
    <div className={styles.tab}>
      <AlongTranscriptSection
        table={table}
        samples={[analyticsSample(sample)]}
        oneSample
        notes={
          table.errors.length > 0 ? (
            <details className={styles.problems}>
              <summary>
                {table.errors.length === 1
                  ? "1 annotation set was left out as invalid"
                  : `${table.errors.length} annotation sets were left out as invalid`}
              </summary>
              <ul>
                {table.errors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            </details>
          ) : null
        }
      />
    </div>
  );
};
