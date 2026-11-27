// Views of a log's text annotations, React-free (lint-enforced in
// eslint.config.js). A view is a parameter type and a pure function from the
// span table (`SpanTable`) and the samples to what its renderer draws; a new
// view adds both here and a renderer in `../`.

export type { LayerInfo, SampleSpanTable, SpanTable } from "./spanTable";
export {
  alignedLayers,
  mergeSpanTables,
  sampleKey,
  sampleSpanTable,
  spanKey,
} from "./spanTable";

export type { Domain, LinearMap } from "./scales";
export { linearMap, niceDomain, ticks } from "./scales";

export type {
  AlongTranscript,
  AlongTranscriptParams,
  AnalyticsSample,
  FieldRef,
  Panel,
  PanelGroup,
  PanelMarker,
  PanelPoint,
  ScoreValue,
  SeriesAxis,
  SeriesParams,
} from "./alongTranscript";
export {
  alongTranscript,
  defaultParams,
  kAggregations,
  kMaxColumns,
  kMaxSeries,
  layerFields,
  resolveParams,
  sampleScores,
  scoreText,
} from "./alongTranscript";
