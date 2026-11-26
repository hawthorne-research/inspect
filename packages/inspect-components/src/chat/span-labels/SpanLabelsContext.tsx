import { createContext, useContext } from "react";

import type { LabelledSpan, SpanLabelQuestion, SpanLabels } from "./spanLabels";

/** Validated span labels for the sample on screen, plus the legend's view
 *  state. Absent outside a labelled sample, so chat views render as usual. */
export interface SpanLabelsView {
  labels: SpanLabels;
  /** Spans grouped by `partKey`, sorted by start. */
  spansByPart: ReadonlyMap<string, readonly LabelledSpan[]>;
  colorBy: SpanLabelQuestion;
  /** Options of `colorBy` to keep at full strength; empty keeps all. */
  highlighted: readonly string[];
  /** A paragraph to flash (by `spanKey`) after the strip scrolled to it;
   *  `nonce` changes per request so a repeat replays the flash. */
  flash?: { key: string; nonce: number };
}

export const SpanLabelsContext = createContext<SpanLabelsView | undefined>(
  undefined
);

export const useSpanLabels = (): SpanLabelsView | undefined =>
  useContext(SpanLabelsContext);
