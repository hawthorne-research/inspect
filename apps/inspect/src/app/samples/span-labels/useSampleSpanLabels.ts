import { RefObject, useState } from "react";

import type { ChatMessage, EvalSample } from "@tsmono/inspect-common/types";
import {
  buildMessageRows,
  buildStripSegments,
  loadSpanLabels,
  warnSpanLabels,
  type ChatViewListHandle,
  type SpanLabelsView,
  type StripSegment,
} from "@tsmono/inspect-components/chat";

import { kDefaultMessageRowOptions } from "../../../log_data";

import { scrollToSpan } from "./scrollToSpan";

const kFlashMs = 2000;

export interface SampleSpanLabels {
  view: SpanLabelsView;
  segments: StripSegment[];
  setColorBy: (question: string) => void;
  toggleHighlight: (option: string) => void;
  clearHighlight: () => void;
  /** Scrolls the messages list to a segment's paragraph and flashes it. */
  focusSegment: (segment: StripSegment) => void;
}

interface SpanLabelsTargets {
  list: RefObject<ChatViewListHandle | null>;
  scroller: RefObject<HTMLElement | null>;
  /** The sticky legend, whose bottom edge a focused paragraph lands under. */
  legend: RefObject<HTMLElement | null>;
}

/**
 * Owns the paragraph-label concern for a sample: reads the classifier's
 * `span_labels` score metadata, validates it against the sample's messages,
 * builds the legend's composition strip, and tracks the color-by question,
 * highlighted options and the paragraph last focused from the strip.
 * Undefined when the sample has no labels or they fail validation (logged).
 */
export function useSampleSpanLabels(
  sample: EvalSample | undefined,
  targets: SpanLabelsTargets
): SampleSpanLabels | undefined {
  const [colorByName, setColorBy] = useState("");
  const [highlight, setHighlight] = useState<{
    question: string;
    options: string[];
  }>({ question: "", options: [] });
  const [flash, setFlash] = useState<{ key: string; nonce: number }>();

  const loaded = sample
    ? loadSpanLabels(sample.scores, sample.messages)
    : undefined;
  if (loaded && !loaded.ok) {
    warnSpanLabels(loaded.error);
  }
  if (!sample || !loaded?.ok) return undefined;

  const { labels, spansByPart } = loaded.value;
  // Derived rather than synced: a stored choice this sample's labels don't
  // have falls back to the first question and an empty highlight.
  const colorBy =
    labels.questions.find((q) => q.name === colorByName) ?? labels.questions[0];
  if (!colorBy) return undefined;
  const highlighted =
    highlight.question === colorBy.name
      ? highlight.options.filter((o) => colorBy.options.includes(o))
      : [];

  const segments = buildStripSegments(
    labels,
    sample.messages,
    chipNumbers(sample.messages)
  );

  const focusSegment = (segment: StripSegment) => {
    const list = targets.list.current;
    const scroller = targets.scroller.current;
    const legend = targets.legend.current;
    if (!list || !scroller || !legend) return;
    const found = scrollToSpan({
      list,
      scroller,
      chrome: legend,
      messageId: segment.span.message_id,
      spanKey: segment.key,
      onLanded: () => {
        const nonce = Date.now();
        setFlash({ key: segment.key, nonce });
        window.setTimeout(() => {
          setFlash((current) =>
            current?.nonce === nonce ? undefined : current
          );
        }, kFlashMs);
      },
    });
    if (!found) {
      console.warn(
        `Span labels: message ${segment.span.message_id} is not loaded in the Messages list`
      );
    }
  };

  return {
    view: { labels, spansByPart, colorBy, highlighted, flash },
    segments,
    setColorBy,
    toggleHighlight: (option) =>
      setHighlight({
        question: colorBy.name,
        options: highlighted.includes(option)
          ? highlighted.filter((o) => o !== option)
          : [...highlighted, option],
      }),
    clearHighlight: () => setHighlight({ question: "", options: [] }),
    focusSegment,
  };
}

/** The number each message shows on its chip in the Messages tab: the
 *  Messages tab folds the same messages with the same row options. */
const chipNumbers = (messages: ChatMessage[]): Map<string, number> => {
  const numbers = new Map<string, number>();
  for (const row of buildMessageRows(messages, kDefaultMessageRowOptions)) {
    const id = row.resolved.message.id;
    if (id) numbers.set(id, row.startNumber);
  }
  return numbers;
};
