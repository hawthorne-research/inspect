import type { ChatMessage } from "@tsmono/inspect-common/types";

import {
  partKey,
  partText,
  spanKey,
  type LabelledSpan,
  type SpanLabels,
} from "./spanLabels";

/** One labelled paragraph on the legend's composition strip. */
export interface StripSegment {
  key: string;
  span: LabelledSpan;
  /** The number on the message's chip in the Messages tab. */
  messageNumber: number;
  /** First segment of its message, so the strip can mark the boundary. */
  startsMessage: boolean;
  /** The paragraph's opening words, whitespace collapsed. */
  preview: string;
}

const kPreviewLength = 80;

/**
 * Labelled paragraphs in transcript order: message order in `messages`,
 * then content index, then start offset. Spans whose message isn't in
 * `messages` are left out. `messageNumbers` maps a message id to the number
 * on its chip; a message without one falls back to its 1-based position.
 */
export const buildStripSegments = (
  labels: SpanLabels,
  messages: readonly ChatMessage[],
  messageNumbers: ReadonlyMap<string, number> = new Map()
): StripSegment[] => {
  const position = new Map<string, number>();
  for (const [index, message] of messages.entries()) {
    if (message.id && !position.has(message.id)) {
      position.set(message.id, index);
    }
  }

  const ordered = labels.spans
    .flatMap((span) => {
      const index = position.get(span.message_id);
      return index === undefined ? [] : [{ span, index }];
    })
    .sort(
      (a, b) =>
        a.index - b.index ||
        a.span.content_index - b.span.content_index ||
        a.span.start - b.span.start
    );

  // Splitting a long reasoning text into code points once per part keeps
  // this linear in the text rather than in text length × paragraphs.
  const codePoints = new Map<string, string[]>();
  const partCodePoints = (span: LabelledSpan, index: number): string[] => {
    const key = partKey(span.message_id, span.content_index);
    let points = codePoints.get(key);
    if (!points) {
      const message = messages[index];
      const text = message ? partText(message, span.content_index) : undefined;
      points = Array.from(text ?? "");
      codePoints.set(key, points);
    }
    return points;
  };

  return ordered.map(({ span, index }, i) => ({
    key: spanKey(span),
    span,
    messageNumber: messageNumbers.get(span.message_id) ?? index + 1,
    startsMessage: ordered[i - 1]?.span.message_id !== span.message_id,
    preview: previewText(
      partCodePoints(span, index).slice(span.start, span.end)
    ),
  }));
};

/** The opening of a paragraph on one line, at most `max` code points. */
export const previewText = (
  codePoints: readonly string[],
  max: number = kPreviewLength
): string => {
  const line = Array.from(codePoints.join("").replace(/\s+/g, " ").trim());
  return line.length > max
    ? `${line.slice(0, max).join("").trimEnd()}…`
    : line.join("");
};
