import { FC, useRef } from "react";
import { useNavigate } from "react-router";

import {
  AlongTranscriptControls,
  AlongTranscriptView,
} from "@tsmono/inspect-components/analytics";
import {
  alongTranscript,
  mergeSpanTables,
  resolveParams,
  sampleScores,
  sampleSpanTable,
  type AlongTranscript,
  type AlongTranscriptParams,
  type AnalyticsSample,
  type PanelPoint,
  type SampleSpanTable,
  type SpanTable,
} from "@tsmono/inspect-components/analytics/model";
import {
  colorScheme,
  type Parsed,
} from "@tsmono/inspect-components/chat/annotations/model";
import {
  ErrorPanel,
  NoContentsPanel,
  ProgressBar,
} from "@tsmono/react/components";
import { useProperty } from "@tsmono/react/hooks";

import type { SampleSummary } from "../../../client/api/types";
import { kLogViewAnalyticsTabId } from "../../../constants";
import {
  useSampleProjections,
  type SampleProjection,
  type SampleProjections,
} from "../../../log_data";
import { useEvalSpec, useSelectedSampleSummaries } from "../../../state/hooks";
import { useCurrentLogFile } from "../../routing/currentSelection";
import {
  sampleMessageUrl,
  useLogRouteParams,
  useSampleUrlBuilder,
} from "../../routing/url";
import { useDarkTheme } from "../../samples/annotations/useDarkTheme";
import { useAnnotationScheme } from "../../samples/annotations/useSampleAnnotations";

import styles from "./AnalyticsTab.module.css";

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
const kParamsBag = "analytics";

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
  // Remembered across logs, and checked against each log by resolveParams.
  const [stored, setStored] = useProperty<unknown>(
    kParamsBag,
    "along-transcript"
  );
  const [schemeId] = useAnnotationScheme();
  const palette = { scheme: colorScheme(schemeId), dark: useDarkTheme() };
  const openSpan = useOpenSpan();

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
  if (table.layers.length === 0) {
    return (
      <div className={styles.tab}>
        <LoadProblems loaded={loaded} />
        <NoContentsPanel text="No sample of this log has text annotations." />
      </div>
    );
  }
  const params = resolveParams(stored, table, samples);
  const view = viewOf(table, samples, params);
  const setParams = (next: AlongTranscriptParams) => setStored(next);

  return (
    <div className={styles.tab}>
      <h2 className={styles.title}>Along the transcript</h2>
      <AlongTranscriptControls
        params={params}
        view={view.ok ? view.value : undefined}
        layers={table.layers}
        scores={sampleScores(table, samples)}
        onChange={setParams}
      />
      <LoadProblems loaded={loaded} />
      {view.ok ? (
        <AlongTranscriptView
          view={view.value}
          palette={palette}
          onSelectSpan={openSpan}
        />
      ) : (
        <ErrorPanel
          title="Unable to draw the view"
          error={{ message: view.error }}
        />
      )}
    </div>
  );
};

const analyticsSample = (summary: SampleSummary): AnalyticsSample => ({
  id: summary.id,
  epoch: summary.epoch,
  scores: Object.fromEntries(
    Object.entries(summary.scores ?? {}).map(([name, score]) => [
      name,
      score.value,
    ])
  ),
});

// Data that two spans can't share a position in (e.g. a layer name used by
// two scores) makes the view throw; that is shown, not a crash.
const viewOf = (
  table: SpanTable,
  samples: readonly AnalyticsSample[],
  params: AlongTranscriptParams
): Parsed<AlongTranscript> => {
  try {
    return { ok: true, value: alongTranscript(table, samples, params) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

/** Opens a sample's Messages tab at the message of a span. */
const useOpenSpan = () => {
  const navigate = useNavigate();
  const builder = useSampleUrlBuilder();
  const { logPath } = useLogRouteParams();
  return (sample: AnalyticsSample, point: PanelPoint) => {
    if (!logPath) return;
    navigate(
      sampleMessageUrl(
        builder,
        encodeURIComponent(point.messageId),
        logPath,
        sample.id,
        sample.epoch
      )
    );
  };
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
      ? `${invalid.length} annotation layers were left out as invalid`
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
