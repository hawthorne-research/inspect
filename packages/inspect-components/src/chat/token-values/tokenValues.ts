import type { ChatMessage, Content, Score } from "@tsmono/inspect-common/types";
import { isRecord } from "@tsmono/util";

import { kMergedSystemMessageId } from "../messages";

/** Score metadata key that carries per-token probe values. */
export const kTokenValuesKey = "token_values";

export interface TokenProbe {
  name: string;
  description: string | null;
  layer: number | null;
}

/** One content part's tokens as stored: `starts`/`ends` are Unicode
 *  code-point offsets (Python `str` indices) into the part's text, end
 *  exclusive, and `values` holds one value per token for every probe. */
export interface TokenValuesPart {
  message_id: string;
  /** Null when the message's content is a plain string. */
  content_index: number | null;
  starts: number[];
  ends: number[];
  values: Record<string, number[]>;
}

export interface TokenValues {
  version: 0;
  unit: string;
  tokenizer: string;
  probes: TokenProbe[];
  parts: TokenValuesPart[];
}

/** A part resolved against the sample's messages, ready to render.
 *  `starts`/`ends` are UTF-16 indices into `text`. */
export interface TokenPart {
  /** Position in transcript order; identifies the part in the DOM. */
  index: number;
  messageId: string;
  contentIndex: number | null;
  kind: "text" | "reasoning";
  text: string;
  starts: readonly number[];
  ends: readonly number[];
  values: Readonly<Record<string, readonly number[]>>;
}

export interface LoadedTokenValues {
  unit: string;
  tokenizer: string;
  probes: readonly TokenProbe[];
  /** Parts in transcript order (message order, then content index). */
  parts: readonly TokenPart[];
  partsByKey: ReadonlyMap<string, TokenPart>;
  /** Parts of the merged system row's content entries, in its order. */
  systemParts: readonly (TokenPart | undefined)[];
  tokenCount: number;
}

/** The parts of one rendered message that carry token values. */
export interface MessageTokenParts {
  /** The message's string content. */
  whole?: TokenPart;
  /** Parts of an array content, keyed by the part object: renderers see
   *  parts after turn segmentation, which keeps identity but not index. */
  byPart: ReadonlyMap<Content, TokenPart>;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** The raw `token_values` value of the first score that carries one. */
export const findTokenValues = (
  scores: Record<string, Score> | null | undefined
): unknown => {
  for (const score of Object.values(scores ?? {})) {
    const metadata: unknown = score.metadata;
    if (isRecord(metadata) && Object.hasOwn(metadata, kTokenValuesKey)) {
      return metadata[kTokenValuesKey];
    }
  }
  return undefined;
};

/** The sample's token values, validated against its messages: undefined
 *  when no score carries any, an error when they are malformed. */
export const loadTokenValues = (
  scores: Record<string, Score> | null | undefined,
  messages: readonly ChatMessage[]
): Parsed<LoadedTokenValues> | undefined => {
  const raw = findTokenValues(scores);
  if (raw === undefined) return undefined;
  const parsed = parseTokenValues(raw);
  if (!parsed.ok) return parsed;
  return resolveTokenParts(parsed.value, messages);
};

const warned = new Set<string>();

/** Logs each distinct token-value problem once rather than on every
 *  render. */
export const warnTokenValues = (error: string): void => {
  if (warned.has(error)) return;
  warned.add(error);
  console.warn(`Token values not shown: ${error}`);
};

/** Validates the `token_values` shape: probes are named uniquely, every
 *  part has one finite value per token for exactly those probes, tokens are
 *  non-empty and in order without overlap, and no two parts address the
 *  same content part. */
export const parseTokenValues = (raw: unknown): Parsed<TokenValues> => {
  if (!isRecord(raw)) return fail("token_values is not an object");
  if (raw["version"] !== 0) {
    return fail(`unsupported version ${String(raw["version"])}`);
  }
  const unit = raw["unit"];
  const tokenizer = raw["tokenizer"];
  if (typeof unit !== "string") return fail("unit is not a string");
  if (typeof tokenizer !== "string") return fail("tokenizer is not a string");

  const probes = parseProbes(raw["probes"]);
  if (!probes.ok) return probes;
  const probeNames = probes.value.map((p) => p.name);

  const rawParts = raw["parts"];
  if (!Array.isArray(rawParts)) return fail("parts is not an array");
  const parts: TokenValuesPart[] = [];
  const seen = new Set<string>();
  for (const [i, rawPart] of rawParts.entries()) {
    const part = parsePart(rawPart, probeNames);
    if (!part.ok) return fail(`parts[${i}]: ${part.error}`);
    const key = partKey(part.value.message_id, part.value.content_index);
    if (seen.has(key)) return fail(`parts[${i}]: ${key} has values twice`);
    seen.add(key);
    parts.push(part.value);
  }

  return {
    ok: true,
    value: { version: 0, unit, tokenizer, probes: probes.value, parts },
  };
};

/** Checks every part against `messages` (the message exists and the
 *  addressed content has text that the offsets fit) and converts its
 *  offsets to UTF-16 indices. */
export const resolveTokenParts = (
  values: TokenValues,
  messages: readonly ChatMessage[]
): Parsed<LoadedTokenValues> => {
  const position = new Map<string, number>();
  for (const [index, message] of messages.entries()) {
    if (message.id && !position.has(message.id)) {
      position.set(message.id, index);
    }
  }

  const located: Array<{ part: TokenValuesPart; position: number }> = [];
  for (const part of values.parts) {
    const index = position.get(part.message_id);
    if (index === undefined) {
      return fail(`message ${part.message_id} not found`);
    }
    located.push({ part, position: index });
  }
  located.sort(
    (a, b) =>
      a.position - b.position ||
      (a.part.content_index ?? -1) - (b.part.content_index ?? -1)
  );

  const parts: TokenPart[] = [];
  const partsByKey = new Map<string, TokenPart>();
  let tokenCount = 0;
  for (const { part, position: index } of located) {
    const key = partKey(part.message_id, part.content_index);
    const message = messages[index];
    const target = message
      ? partTarget(message, part.content_index)
      : undefined;
    if (!target) return fail(`${key} is not a text or reasoning part`);
    const offsets = codePointOffsets(target.text);
    const length = offsets.length - 1;
    const lastEnd = part.ends[part.ends.length - 1] ?? 0;
    if (lastEnd > length) {
      return fail(
        `${key}: token end ${lastEnd} is past the text's ${length} code points`
      );
    }
    const resolved: TokenPart = {
      index: parts.length,
      messageId: part.message_id,
      contentIndex: part.content_index,
      kind: target.kind,
      text: target.text,
      starts: part.starts.map((s) => offsets[s] ?? 0),
      ends: part.ends.map((e) => offsets[e] ?? 0),
      values: part.values,
    };
    parts.push(resolved);
    partsByKey.set(key, resolved);
    tokenCount += part.starts.length;
  }

  return {
    ok: true,
    value: {
      unit: values.unit,
      tokenizer: values.tokenizer,
      probes: values.probes,
      parts,
      partsByKey,
      systemParts: mergedSystemParts(partsByKey, messages),
      tokenCount,
    },
  };
};

/** The parts of `message` that carry token values. The chat's merged
 *  system row maps its entries back to the system messages they came
 *  from. */
export const messageTokenParts = (
  values: LoadedTokenValues,
  message: ChatMessage
): MessageTokenParts | undefined => {
  if (!message.id) return undefined;
  if (typeof message.content === "string") {
    const whole = values.partsByKey.get(partKey(message.id, null));
    return whole ? { whole, byPart: new Map() } : undefined;
  }
  const merged = message.id === kMergedSystemMessageId;
  if (merged && message.content.length !== values.systemParts.length) {
    return undefined;
  }
  const byPart = new Map<Content, TokenPart>();
  for (const [index, content] of message.content.entries()) {
    const part = merged
      ? values.systemParts[index]
      : values.partsByKey.get(partKey(message.id, index));
    if (part) byPart.set(content, part);
  }
  return byPart.size > 0 ? { byPart } : undefined;
};

export const partKey = (
  messageId: string,
  contentIndex: number | null
): string => `${messageId}[${contentIndex ?? "content"}]`;

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

/** The text of token `token` of `part`. */
export const tokenText = (part: TokenPart, token: number): string =>
  part.text.slice(part.starts[token] ?? 0, part.ends[token] ?? 0);

/** A probe's name, with its layer when it has one. */
export const probeLabel = (probe: TokenProbe): string =>
  probe.layer === null ? probe.name : `${probe.name} · layer ${probe.layer}`;

const partTarget = (
  message: ChatMessage,
  contentIndex: number | null
): { text: string; kind: TokenPart["kind"] } | undefined => {
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

/** One entry per content entry of the merged system row (a string content
 *  counts as one entry), mirroring `mergedSystemMessage`. */
const mergedSystemParts = (
  partsByKey: ReadonlyMap<string, TokenPart>,
  messages: readonly ChatMessage[]
): (TokenPart | undefined)[] =>
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

const parseProbes = (raw: unknown): Parsed<TokenProbe[]> => {
  if (!Array.isArray(raw) || raw.length === 0) {
    return fail("probes is not a non-empty array");
  }
  const probes: TokenProbe[] = [];
  for (const [i, p] of raw.entries()) {
    if (!isRecord(p)) return fail(`probes[${i}] is not an object`);
    const name = p["name"];
    const description = p["description"] ?? null;
    const layer = p["layer"] ?? null;
    if (typeof name !== "string" || !name) {
      return fail(`probes[${i}].name is not a non-empty string`);
    }
    if (description !== null && typeof description !== "string") {
      return fail(`probes[${i}].description is not a string`);
    }
    if (layer !== null && !isFiniteNumber(layer)) {
      return fail(`probes[${i}].layer is not a number`);
    }
    if (probes.some((other) => other.name === name)) {
      return fail(`probe ${name} is defined twice`);
    }
    probes.push({ name, description, layer });
  }
  return { ok: true, value: probes };
};

const parsePart = (
  raw: unknown,
  probeNames: readonly string[]
): Parsed<TokenValuesPart> => {
  if (!isRecord(raw)) return fail("not an object");
  const messageId = raw["message_id"];
  const contentIndex = raw["content_index"];
  const starts = raw["starts"];
  const ends = raw["ends"];
  if (typeof messageId !== "string" || !messageId) {
    return fail("message_id is not a string");
  }
  if (contentIndex !== null && !isNonNegativeInt(contentIndex)) {
    return fail("content_index is not null or a non-negative integer");
  }
  if (!isOffsetArray(starts) || !isOffsetArray(ends)) {
    return fail("starts and ends are not arrays of non-negative integers");
  }
  if (starts.length !== ends.length) {
    return fail(`${starts.length} starts but ${ends.length} ends`);
  }
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i] ?? 0;
    const end = ends[i] ?? 0;
    if (start >= end) return fail(`token ${i} is empty: [${start}, ${end})`);
    const prevEnd = i > 0 ? (ends[i - 1] ?? 0) : 0;
    if (start < prevEnd) {
      return fail(`token ${i} starts at ${start}, before the previous end`);
    }
  }

  const rawValues = raw["values"];
  if (!isRecord(rawValues)) return fail("values is not an object");
  const keys = Object.keys(rawValues);
  const extra = keys.find((k) => !probeNames.includes(k));
  if (extra !== undefined) return fail(`values for unknown probe ${extra}`);
  const values: Record<string, number[]> = {};
  for (const name of probeNames) {
    const series = rawValues[name];
    if (series === undefined) return fail(`no values for probe ${name}`);
    if (!Array.isArray(series) || series.length !== starts.length) {
      return fail(`values.${name} does not have one value per token`);
    }
    if (!series.every(isFiniteNumber)) {
      return fail(`values.${name} has a value that is not a finite number`);
    }
    values[name] = series;
  }

  return {
    ok: true,
    value: {
      message_id: messageId,
      content_index: contentIndex,
      starts,
      ends,
      values,
    },
  };
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isNonNegativeInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isOffsetArray = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every(isNonNegativeInt);

const fail = (error: string): { ok: false; error: string } => ({
  ok: false,
  error,
});
