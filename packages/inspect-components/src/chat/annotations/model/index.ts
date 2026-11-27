// The data model of `Score.metadata["text_annotations"]`, for any view of
// it: no React, DOM or drawing code (lint-enforced in eslint.config.js).

export type {
  AnnotationField,
  AnnotationLayer,
  AnnotationMetadata,
  AnnotationPart,
  CategoricalField,
  NumericField,
  Parsed,
} from "./format";
export {
  kFormatVersion,
  kTextAnnotationsKey,
  parseTextAnnotations,
  partKey,
} from "./format";

export type { CollectedLayers, ResolvedLayer, ResolvedPart } from "./layers";
export {
  collectAnnotationLayers,
  layerId,
  spanText,
  warnAnnotations,
} from "./layers";

export type { SpanPosition } from "./position";
export { formatSpanOffsets, locateSpan, parseSpanOffsets } from "./position";

export {
  fieldDetails,
  fieldTitle,
  metadataEntries,
  metadataText,
  spanCountLabel,
} from "./describe";

export type { ColorScheme, Palette, SchemeColors, SpanStyle } from "./schemes";
export {
  colorScheme,
  kColorSchemes,
  paletteColors,
  stepColorScheme,
  textOn,
  withAlpha,
} from "./schemes";

export type { OptionColor } from "./categorical";
export {
  countOptions,
  isNegative,
  optionColor,
  optionStyle,
  summaryOption,
} from "./categorical";

export {
  fieldScale,
  formatValue,
  magnitudeScale,
  peakIndex,
  valueIntensity,
  valueStyle,
} from "./numeric";

export type { AnnotationView, OptionProbability, SpanValue } from "./view";
export { annotationView, spanStyle, spanValue } from "./view";

export type { SpanLocation, StripSegment } from "./strip";
export { buildStrip, kMaxStripSegments } from "./strip";

export type {
  Aggregation,
  FieldCell,
  FieldColumn,
  FieldOptions,
  LayerFields,
  ProbabilityColumn,
  SampleSource,
  SpanRow,
  SpanRowOptions,
  SpanRows,
} from "./table";
export {
  alignLayers,
  fieldColumn,
  probabilityColumn,
  rollUp,
  spanRows,
} from "./table";
