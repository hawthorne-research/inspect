import type { CSSProperties } from "react";

import { summaryOption } from "./categorical";
import { spanText, type ResolvedPart } from "./layers";
import { formatValue, peakIndex } from "./numeric";
import { spanStyle, type AnnotationView } from "./view";

/** Addresses one span of a layer: its part's `index`, and the span's index
 *  within the part. */
export interface SpanLocation {
  part: number;
  span: number;
}

/** The overview strip's resolution. */
export const kMaxStripSegments = 300;

/** One segment of the overview strip: a run of spans in transcript order,
 *  shown by one of them. */
export interface StripSegment {
  /** The span that colours the segment and that a click scrolls to. */
  location: SpanLocation;
  /** How many spans the segment covers. */
  count: number;
  /** What the shown span stands for, e.g. an option or a peak value. */
  label: string;
  style: CSSProperties | undefined;
  /** The number on the shown span's message chip in the Messages tab. */
  messageNumber: number;
  /** A message other than the previous segment's begins in the segment. */
  startsMessage: boolean;
  /** The shown span's text. */
  text: string;
}

interface SpanRef {
  part: ResolvedPart;
  span: number;
}

/**
 * The view's layer in transcript order as at most `maxSegments` segments
 * of equal count (sizes differ by at most one), so one span per segment
 * when the layer has that few. `messageNumbers` maps a message id to the
 * number on its chip; a message without one falls back to its 1-based
 * position.
 */
export const buildStrip = (
  view: AnnotationView,
  messageNumbers: ReadonlyMap<string, number> = new Map(),
  maxSegments: number = kMaxStripSegments
): StripSegment[] => {
  const spans: SpanRef[] = view.layer.parts.flatMap((part) =>
    part.starts.map((_, span) => ({ part, span }))
  );
  const count = Math.min(maxSegments, spans.length);
  const segments: StripSegment[] = [];
  let from = 0;
  for (let i = 0; i < count; i++) {
    const to = Math.floor(((i + 1) * spans.length) / count);
    const run = spans.slice(from, to);
    const summary = summarise(view, run);
    const shown = run[summary.index] ?? run[0];
    if (shown) {
      const { part, span } = shown;
      segments.push({
        location: { part: part.index, span },
        count: run.length,
        label: summary.label,
        style: spanStyle(view, part, span),
        messageNumber:
          messageNumbers.get(part.messageId) ?? part.messagePosition + 1,
        startsMessage: run.some(
          (ref, k) =>
            from + k > 0 &&
            spans[from + k - 1]?.part.messageId !== ref.part.messageId
        ),
        text: spanText(part, span),
      });
    }
    from = to;
  }
  return segments;
};

/** Which of a segment's spans shows it, and what it stands for: the peak
 *  of a numeric field, the most frequent option of a categorical one. */
const summarise = (
  view: AnnotationView,
  run: readonly SpanRef[]
): { index: number; label: string } => {
  const { field } = view;
  if (field.type === "numeric") {
    const values = run.map(
      ({ part, span }) => part.values.get(field.name)?.[span] ?? 0
    );
    const index = peakIndex(values);
    const value = formatValue(values[index] ?? 0);
    return { index, label: run.length > 1 ? `peak ${value}` : value };
  }
  const labels = run.map(
    ({ part, span }) => part.labels.get(field.name)?.[span]
  );
  const option = summaryOption(field, labels, view.highlighted);
  const index = Math.max(0, labels.indexOf(option));
  if (option === undefined) return { index, label: "—" };
  if (run.length === 1) return { index, label: option };
  const matching = labels.filter((l) => l === option).length;
  return { index, label: `${option} (${matching})` };
};
