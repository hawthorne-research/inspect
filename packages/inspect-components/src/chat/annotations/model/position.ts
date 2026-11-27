import { partKey } from "./format";
import type { ResolvedSet } from "./sets";
import type { SpanLocation } from "./strip";

/**
 * Where a span is in a sample's messages, whichever annotation set has it:
 * sets with the same spans (e.g. two classifiers of the same paragraphs)
 * have a span at the same position. `start`/`end` are code-point offsets, as
 * stored.
 */
export interface SpanPosition {
  messageId: string;
  contentIndex: number | null;
  start: number;
  end: number;
}

/** The span of `set` at `position`, if the set has one there. */
export const locateSpan = (
  set: ResolvedSet,
  position: SpanPosition
): SpanLocation | undefined => {
  const part = set.partsByKey.get(
    partKey(position.messageId, position.contentIndex)
  );
  if (!part) return undefined;
  const span = part.codePointStarts.findIndex(
    (start, i) =>
      start === position.start && part.codePointEnds[i] === position.end
  );
  return span < 0 ? undefined : { part: part.index, span };
};

/** A position's place within its message as text,
 *  `<content index>:<start>-<end>`, with no content index for a message
 *  whose content is a string. The message id is left to the caller. */
export const formatSpanOffsets = ({
  contentIndex,
  start,
  end,
}: SpanPosition): string => `${contentIndex ?? ""}:${start}-${end}`;

/** The position `formatSpanOffsets` wrote for a span of `messageId`;
 *  undefined when `text` isn't one. */
export const parseSpanOffsets = (
  messageId: string,
  text: string
): SpanPosition | undefined => {
  const match = /^(\d*):(\d+)-(\d+)$/.exec(text);
  if (!match) return undefined;
  const [, contentIndex = "", start = "", end = ""] = match;
  const position = {
    messageId,
    contentIndex: contentIndex === "" ? null : Number(contentIndex),
    start: Number(start),
    end: Number(end),
  };
  return position.start <= position.end ? position : undefined;
};
