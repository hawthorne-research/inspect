import type { ChatMessage, Score } from "@tsmono/inspect-common/types";
import { isRecord } from "@tsmono/util";

import { kMergedSystemMessageId, type Message } from "..";

import {
  fail,
  kTextAnnotationsKey,
  parseTextAnnotations,
  partKey,
  type AnnotationLayer,
  type AnnotationPart,
  type Parsed,
} from "./format";

/** A content part's spans resolved against the sample's messages, ready to
 *  render. `starts`/`ends` are UTF-16 indices into `text`. */
export interface ResolvedPart extends Pick<
  AnnotationPart,
  "labels" | "values" | "probabilities"
> {
  /** Position in the layer's transcript order; identifies it in the DOM. */
  index: number;
  messageId: string;
  /** Position of the message in the sample's messages. */
  messagePosition: number;
  contentIndex: number | null;
  kind: "text" | "reasoning";
  text: string;
  starts: readonly number[];
  ends: readonly number[];
}

/** A layer whose parts all resolved against the sample's messages. */
export interface ResolvedLayer extends Omit<AnnotationLayer, "parts"> {
  /** Unique within the sample: the score's name and the layer's. */
  id: string;
  score: string;
  /** In transcript order: message order, then content index. */
  parts: readonly ResolvedPart[];
  spanCount: number;
  partsByKey: ReadonlyMap<string, ResolvedPart>;
  /** Parts of the chat's merged system row, by its content entries. */
  systemParts: readonly (ResolvedPart | undefined)[];
}

export interface CollectedLayers {
  layers: ResolvedLayer[];
  /** One message per score or layer left out as invalid. */
  errors: string[];
}

/**
 * Every valid annotation layer of the sample's scores, in score order, each
 * checked against `messages`. A score or layer that fails validation is
 * left out with an error; the others still resolve.
 */
export const collectAnnotationLayers = (
  scores: Record<string, Score> | null | undefined,
  messages: readonly ChatMessage[]
): CollectedLayers => {
  const layers: ResolvedLayer[] = [];
  const errors: string[] = [];
  for (const [score, value] of Object.entries(scores ?? {})) {
    const metadata: unknown = value.metadata;
    if (!isRecord(metadata) || !Object.hasOwn(metadata, kTextAnnotationsKey)) {
      continue;
    }
    const parsed = parseTextAnnotations(metadata[kTextAnnotationsKey]);
    if (!parsed.ok) {
      errors.push(`score "${score}": ${parsed.error}`);
      continue;
    }
    for (const layer of parsed.value) {
      const resolved = layer.ok
        ? resolveLayer(score, layer.value, messages)
        : layer;
      if (resolved.ok) {
        layers.push(resolved.value);
      } else {
        errors.push(`score "${score}": ${resolved.error}`);
      }
    }
  }
  return { layers, errors };
};

const warned = new Set<string>();

/** Logs each distinct annotation problem once rather than on every
 *  render. */
export const warnAnnotations = (error: string): void => {
  if (warned.has(error)) return;
  warned.add(error);
  console.warn(`Text annotations not shown: ${error}`);
};

/** Checks every part of `layer` against `messages` (the message exists and
 *  the addressed content has text that the offsets fit) and converts its
 *  offsets to UTF-16 indices. */
export const resolveLayer = (
  score: string,
  layer: AnnotationLayer,
  messages: readonly ChatMessage[]
): Parsed<ResolvedLayer> => {
  const position = new Map<string, number>();
  for (const [index, message] of messages.entries()) {
    if (message.id && !position.has(message.id)) {
      position.set(message.id, index);
    }
  }

  const located: Array<{ part: AnnotationPart; position: number }> = [];
  for (const part of layer.parts) {
    const index = position.get(part.messageId);
    if (index === undefined) {
      return fail(`layer "${layer.name}": message ${part.messageId} not found`);
    }
    located.push({ part, position: index });
  }
  located.sort(
    (a, b) =>
      a.position - b.position ||
      (a.part.contentIndex ?? -1) - (b.part.contentIndex ?? -1)
  );

  const parts: ResolvedPart[] = [];
  const partsByKey = new Map<string, ResolvedPart>();
  let spanCount = 0;
  for (const { part, position: messagePosition } of located) {
    const key = partKey(part.messageId, part.contentIndex);
    const message = messages[messagePosition];
    const target = message ? partText(message, part.contentIndex) : undefined;
    if (!target) {
      return fail(
        `layer "${layer.name}": ${key} is not a text or reasoning part`
      );
    }
    const offsets = codePointOffsets(target.text);
    const length = offsets.length - 1;
    const lastEnd = part.ends[part.ends.length - 1] ?? 0;
    if (lastEnd > length) {
      return fail(
        `layer "${layer.name}": ${key}: span end ${lastEnd} is past the text's ${length} code points`
      );
    }
    const resolved: ResolvedPart = {
      index: parts.length,
      messageId: part.messageId,
      messagePosition,
      contentIndex: part.contentIndex,
      kind: target.kind,
      text: target.text,
      starts: part.starts.map((s) => offsets[s] ?? 0),
      ends: part.ends.map((e) => offsets[e] ?? 0),
      labels: part.labels,
      values: part.values,
      probabilities: part.probabilities,
    };
    parts.push(resolved);
    partsByKey.set(key, resolved);
    spanCount += part.starts.length;
  }

  return {
    ok: true,
    value: {
      // JSON keeps the pair unambiguous whatever characters the names hold.
      id: JSON.stringify([score, layer.name]),
      score,
      name: layer.name,
      unit: layer.unit,
      source: layer.source,
      tokenizer: layer.tokenizer,
      description: layer.description,
      fields: layer.fields,
      parts,
      spanCount,
      partsByKey,
      systemParts: mergedSystemParts(partsByKey, messages),
    },
  };
};

/** The part of `layer` that annotates part `contentIndex` of `message` as
 *  the chat renders it. The chat's merged system row maps its entries back
 *  to the system messages they came from. */
export const findPart = (
  layer: ResolvedLayer,
  message: Message,
  contentIndex: number | null
): ResolvedPart | undefined => {
  if (!message.id) return undefined;
  if (message.id !== kMergedSystemMessageId) {
    return layer.partsByKey.get(partKey(message.id, contentIndex));
  }
  if (
    contentIndex === null ||
    typeof message.content === "string" ||
    message.content.length !== layer.systemParts.length
  ) {
    return undefined;
  }
  return layer.systemParts[contentIndex];
};

/** Whether any part of `message`, as the chat renders it, is annotated. */
export const hasAnnotatedPart = (
  layer: ResolvedLayer,
  message: Message
): boolean => {
  if (typeof message.content === "string") {
    return findPart(layer, message, null) !== undefined;
  }
  return message.content.some(
    (_, index) => findPart(layer, message, index) !== undefined
  );
};

/** The text that span offsets index into: a text part's `text`, a
 *  reasoning part's `reasoning`, or the message's string content. */
export const partText = (
  message: ChatMessage,
  contentIndex: number | null
): { text: string; kind: ResolvedPart["kind"] } | undefined => {
  if (contentIndex === null) {
    return typeof message.content === "string"
      ? { text: message.content, kind: "text" }
      : undefined;
  }
  if (typeof message.content === "string") return undefined;
  const part = message.content[contentIndex];
  if (part?.type === "reasoning") {
    return { text: part.reasoning, kind: "reasoning" };
  }
  if (part?.type === "text") return { text: part.text, kind: "text" };
  return undefined;
};

/** The UTF-16 index where each code point of `text` starts, followed by
 *  `text.length`: entry k converts code-point offset k. Lone surrogates
 *  count as one code point, as in Python and `Array.from`. */
export const codePointOffsets = (text: string): number[] => {
  const offsets: number[] = [];
  let i = 0;
  while (i < text.length) {
    offsets.push(i);
    i += (text.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
  }
  offsets.push(text.length);
  return offsets;
};

/** The text of span `span` of `part`. */
export const spanText = (part: ResolvedPart, span: number): string =>
  part.text.slice(part.starts[span] ?? 0, part.ends[span] ?? 0);

/** A run of a part's text: one of its spans, or the text between spans. */
export interface TextSegment {
  text: string;
  /** The span's index in its part; undefined between spans. */
  span?: number;
}

/** Cuts a part's text into its spans and the runs between them, dropping
 *  runs that are only whitespace. */
export const textSegments = (part: ResolvedPart): TextSegment[] => {
  const segments: TextSegment[] = [];
  const pushGap = (from: number, to: number) => {
    const gap = part.text.slice(from, to);
    if (gap.trim()) segments.push({ text: gap });
  };
  let cursor = 0;
  for (let span = 0; span < part.starts.length; span++) {
    const start = part.starts[span] ?? cursor;
    const end = part.ends[span] ?? start;
    pushGap(cursor, start);
    segments.push({ text: part.text.slice(start, end), span });
    cursor = end;
  }
  pushGap(cursor, part.text.length);
  return segments;
};

/** One entry per content entry of the merged system row (a string content
 *  counts as one entry), mirroring `mergedSystemMessage`. */
const mergedSystemParts = (
  partsByKey: ReadonlyMap<string, ResolvedPart>,
  messages: readonly ChatMessage[]
): (ResolvedPart | undefined)[] =>
  messages.flatMap((message) => {
    if (message.role !== "system") return [];
    const id = message.id;
    if (typeof message.content === "string") {
      return [id ? partsByKey.get(partKey(id, null)) : undefined];
    }
    return message.content.map((_, index) =>
      id ? partsByKey.get(partKey(id, index)) : undefined
    );
  });
