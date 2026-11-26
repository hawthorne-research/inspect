// Annotations of transcript text (`Score.metadata["text_annotations"]`).
// Uses the chat components only through their public API, so it can move.

export type {
  AnnotationField,
  AnnotationLayer,
  AnnotationPart,
  CategoricalField,
  NumericField,
  Parsed,
} from "./format";
export { kTextAnnotationsKey, parseTextAnnotations } from "./format";

export type { CollectedLayers, ResolvedLayer, ResolvedPart } from "./layers";
export { collectAnnotationLayers, warnAnnotations } from "./layers";

export { valueScale } from "./numeric";

export type { LabelSegment, PeakBin, SpanLocation, StripData } from "./strip";
export { buildStrip } from "./strip";

export { flashSpan, spanSelector } from "./dom";

export type { AnnotationView } from "./context";
export { AnnotationsProvider } from "./AnnotationsProvider";
export { AnnotationLegend } from "./AnnotationLegend";
