import type { AnnotationField, CategoricalField, NumericField } from "./format";
import { spanText, type ResolvedLayer, type ResolvedPart } from "./layers";
import { binValues } from "./numeric";

/** Addresses one span of a layer: its part's `index`, and the span's index
 *  within the part. */
export interface SpanLocation {
  part: number;
  span: number;
}

/** One span on a categorical field's strip. */
export interface LabelSegment {
  location: SpanLocation;
  label: string | undefined;
  /** The number on the span's message chip in the Messages tab. */
  messageNumber: number;
  /** First segment of its message, so the strip can mark the boundary. */
  startsMessage: boolean;
  /** The span's opening words, whitespace collapsed. */
  preview: string;
}

/** One bin of a numeric field's strip, located by its peak span. */
export interface PeakBin {
  location: SpanLocation;
  count: number;
  peak: number;
  messageNumber: number;
  /** The peak span's text. */
  text: string;
}

export type StripData =
  | { type: "categorical"; segments: LabelSegment[] }
  | { type: "numeric"; bins: PeakBin[] };

/**
 * The overview strip for `field` of `layer`, in transcript order: one
 * segment per span for a categorical field, at most 300 equal-count bins
 * for a numeric one. `messageNumbers` maps a message id to the number on
 * its chip; a message without one falls back to its 1-based position.
 */
export const buildStrip = (
  layer: ResolvedLayer,
  field: AnnotationField,
  messageNumbers: ReadonlyMap<string, number> = new Map()
): StripData => {
  const numberOf = (part: ResolvedPart) =>
    messageNumbers.get(part.messageId) ?? part.messagePosition + 1;
  return field.type === "categorical"
    ? {
        type: "categorical",
        segments: labelSegments(layer, field, numberOf),
      }
    : { type: "numeric", bins: peakBins(layer, field, numberOf) };
};

const labelSegments = (
  layer: ResolvedLayer,
  field: CategoricalField,
  numberOf: (part: ResolvedPart) => number
): LabelSegment[] => {
  const segments: LabelSegment[] = [];
  let previousMessage: string | undefined;
  for (const part of layer.parts) {
    const labels = part.labels.get(field.name) ?? [];
    for (let span = 0; span < part.starts.length; span++) {
      segments.push({
        location: { part: part.index, span },
        label: labels[span],
        messageNumber: numberOf(part),
        startsMessage: previousMessage !== part.messageId,
        preview: previewText(spanText(part, span)),
      });
      previousMessage = part.messageId;
    }
  }
  return segments;
};

const peakBins = (
  layer: ResolvedLayer,
  field: NumericField,
  numberOf: (part: ResolvedPart) => number
): PeakBin[] =>
  binValues(
    layer.parts.map((part) => part.values.get(field.name) ?? [])
  ).flatMap((bin) => {
    const part = layer.parts[bin.sequence];
    if (!part) return [];
    return [
      {
        location: { part: part.index, span: bin.span },
        count: bin.count,
        peak: bin.peak,
        messageNumber: numberOf(part),
        text: spanText(part, bin.span),
      },
    ];
  });

const kPreviewLength = 80;

/** The opening of a span's text on one line, at most `max` code points. */
export const previewText = (
  text: string,
  max: number = kPreviewLength
): string => {
  const line = Array.from(text.replace(/\s+/g, " ").trim());
  return line.length > max
    ? `${line.slice(0, max).join("").trimEnd()}…`
    : line.join("");
};
