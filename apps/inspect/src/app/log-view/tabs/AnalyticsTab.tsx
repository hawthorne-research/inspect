import { FC, useRef } from "react";

import {
  mergeSpanTables,
  sampleSpanTable,
  type SampleSpanTable,
} from "@tsmono/inspect-components/analytics/model";
import {
  ErrorPanel,
  NoContentsPanel,
  ProgressBar,
} from "@tsmono/react/components";

import type { SampleSummary } from "../../../client/api/types";
import { kLogViewAnalyticsTabId } from "../../../constants";
import {
  useSampleProjections,
  type SampleProjection,
  type SampleProjections,
} from "../../../log_data";
import { useEvalSpec, useSelectedSampleSummaries } from "../../../state/hooks";
import { AlongTranscriptSection } from "../../analytics/AlongTranscriptSection";
import styles from "../../analytics/Analytics.module.css";
import { analyticsSample } from "../../analytics/analyticsSample";
import { useCurrentLogFile } from "../../routing/currentSelection";

export const useAnalyticsTabConfig = () => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  return {
    id: kLogViewAnalyticsTabId,
    label: "Analytics",
    scrollable: true,
    scrollRef,
    component: AnalyticsTab,
    componentProps: {},
  };
};

/** Views of the log's text annotations. Mounted only while the tab is
 *  open, so samples load only then. */
const AnalyticsTab: FC = () => {
  const logFile = useCurrentLogFile();
  const evalSpec = useEvalSpec();
  const summaries = useSelectedSampleSummaries();
  if (summaries.error) {
    return (
      <ErrorPanel
        title="Unable to load the log's samples"
        error={summaries.error}
      />
    );
  }
  if (!logFile || !evalSpec || !summaries.data) {
    return <NoContentsPanel text="Loading samples" busy />;
  }
  return (
    <LogAnalytics
      key={logFile}
      logFile={logFile}
      evalId={evalSpec.eval_id}
      summaries={summaries.data}
    />
  );
};

const kProjection = "span-table";

const LogAnalytics: FC<{
  logFile: string;
  evalId: string;
  summaries: readonly SampleSummary[];
}> = ({ logFile, evalId, summaries }) => {
  const projection: SampleProjection<SampleSpanTable> = {
    name: kProjection,
    project: (sample) => sampleSpanTable(sample, { evalId, log: logFile }),
  };
  const loaded = useSampleProjections(
    summaries
      .filter((summary) => summary.completed)
      .map((summary) => ({ id: summary.id, epoch: summary.epoch, logFile })),
    projection
  );

  if (loaded.settled < loaded.total) {
    return (
      <div className={styles.loading}>
        <ProgressBar
          min={0}
          max={loaded.total}
          value={loaded.settled}
          label="samples loaded"
          width="16rem"
        />
      </div>
    );
  }

  const table = mergeSpanTables(loaded.values.map(({ value }) => value));
  const samples = summaries.map(analyticsSample);
  if (table.sets.length === 0) {
    return (
      <div className={styles.tab}>
        <LoadProblems loaded={loaded} />
        <NoContentsPanel text="No sample of this log has text annotations." />
      </div>
    );
  }
  return (
    <div className={styles.tab}>
      <AlongTranscriptSection
        table={table}
        samples={samples}
        notes={<LoadProblems loaded={loaded} />}
      />
    </div>
  );
};

const LoadProblems: FC<{ loaded: SampleProjections<SampleSpanTable> }> = ({
  loaded,
}) => {
  const failed = loaded.errors.map(
    ({ handle, error }) =>
      `${handle.id} epoch ${handle.epoch}: ${error.message}`
  );
  const invalid = loaded.values.flatMap(({ handle, value }) =>
    value.errors.map((error) => `${handle.id} epoch ${handle.epoch}: ${error}`)
  );
  if (failed.length === 0 && invalid.length === 0) return null;
  const summary = [
    failed.length > 0 ? `${failed.length} samples failed to load` : null,
    invalid.length > 0
      ? `${invalid.length} annotation sets were left out as invalid`
      : null,
  ]
    .filter((part) => part !== null)
    .join("; ");
  return (
    <details className={styles.problems}>
      <summary>{summary}</summary>
      <ul>
        {[...failed, ...invalid].map((problem) => (
          <li key={problem}>{problem}</li>
        ))}
      </ul>
    </details>
  );
};
