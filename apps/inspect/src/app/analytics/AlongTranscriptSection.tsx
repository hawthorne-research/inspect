import { FC, ReactNode } from "react";
import { useNavigate } from "react-router";

import {
  AlongTranscriptControls,
  AlongTranscriptView,
} from "@tsmono/inspect-components/analytics";
import {
  alongTranscript,
  resolveParams,
  sampleScores,
  type AlongTranscript,
  type AlongTranscriptParams,
  type AnalyticsSample,
  type Panel,
  type PanelPoint,
  type SpanTable,
} from "@tsmono/inspect-components/analytics/model";
import {
  colorScheme,
  type Parsed,
} from "@tsmono/inspect-components/chat/annotations/model";
import { ErrorPanel } from "@tsmono/react/components";
import { useProperty } from "@tsmono/react/hooks";
import { isRecord } from "@tsmono/util";

import {
  sampleSpanUrl,
  useLogOrSampleRouteParams,
  useSampleUrlBuilder,
} from "../routing/url";
import { useDarkTheme } from "../samples/annotations/useDarkTheme";
import { useAnnotationScheme } from "../samples/annotations/useSampleAnnotations";

import styles from "./Analytics.module.css";

const kParamsBag = "analytics";
const kOneSamplePanelHeight = 320;

interface AlongTranscriptSectionProps {
  table: SpanTable;
  samples: readonly AnalyticsSample[];
  /** A sample's own view: one wide, tall panel, without the settings that
   *  arrange several samples' panels. */
  oneSample?: boolean;
  /** Shown above the view, e.g. samples that failed to load. */
  notes?: ReactNode;
}

/**
 * The "along the transcript" view of `table` with its settings, for a log's
 * samples or for one sample. The settings are shared by both, and kept
 * across logs (checked against each table by `resolveParams`); one
 * sample's view leaves the stored grouping and columns alone. A click on a
 * panel opens its span in the sample's Messages tab.
 */
export const AlongTranscriptSection: FC<AlongTranscriptSectionProps> = ({
  table,
  samples,
  oneSample = false,
  notes,
}) => {
  const [stored, setStored] = useProperty<unknown>(
    kParamsBag,
    "along-transcript"
  );
  const [schemeId] = useAnnotationScheme();
  const palette = { scheme: colorScheme(schemeId), dark: useDarkTheme() };
  const openSpan = useOpenSpan();

  const resolved = resolveParams(stored, table, samples);
  const params = oneSample
    ? { ...resolved, groupBy: null, columns: 1 }
    : resolved;
  const setParams = (next: AlongTranscriptParams) =>
    setStored(oneSample ? withLayoutOf(next, stored) : next);
  const view = viewOf(table, samples, params);

  return (
    <>
      <h2 className={styles.title}>Along the transcript</h2>
      <AlongTranscriptControls
        params={params}
        view={view.ok ? view.value : undefined}
        layers={table.layers}
        scores={sampleScores(table, samples)}
        oneSample={oneSample}
        onChange={setParams}
      />
      {notes}
      {view.ok ? (
        <AlongTranscriptView
          view={view.value}
          palette={palette}
          onSelectSpan={openSpan}
          panelHeight={oneSample ? kOneSamplePanelHeight : undefined}
        />
      ) : (
        <ErrorPanel
          title="Unable to draw the view"
          error={{ message: view.error }}
        />
      )}
    </>
  );
};

/** `params` with the grouping and columns that `stored` has, if any. */
const withLayoutOf = (
  params: AlongTranscriptParams,
  stored: unknown
): Record<string, unknown> => {
  const { groupBy: _groupBy, columns: _columns, ...rest } = params;
  if (!isRecord(stored)) return rest;
  return { ...rest, groupBy: stored["groupBy"], columns: stored["columns"] };
};

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

/** Opens a panel's span in its sample's Messages tab, in the panel's x
 *  layer unless the layer on screen has the same span. */
const useOpenSpan = () => {
  const navigate = useNavigate();
  const builder = useSampleUrlBuilder();
  const { logPath } = useLogOrSampleRouteParams();
  return (panel: Panel, point: PanelPoint) => {
    if (!logPath) return;
    navigate(
      sampleSpanUrl(
        builder,
        { position: point.position, layer: panel.layerId },
        logPath,
        panel.sample.id,
        panel.sample.epoch
      )
    );
  };
};
