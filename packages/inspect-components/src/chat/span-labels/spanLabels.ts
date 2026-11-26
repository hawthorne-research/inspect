import type {
  ChatMessage,
  ContentReasoning,
  Score,
} from "@tsmono/inspect-common/types";
import { isRecord } from "@tsmono/util";

/** Score metadata key that carries paragraph-level labels from a classifier
 *  run after the eval. */
export const kSpanLabelsKey = "span_labels";

export interface SpanLabelQuestion {
  name: string;
  description: string | null;
  options: string[];
}

/** One labelled span of a content part's text. `start`/`end` are Unicode
 *  code-point offsets (Python `str` indices), end exclusive. */
export interface LabelledSpan {
  message_id: string;
  content_index: number;
  start: number;
  end: number;
  labels: Record<string, string>;
  probabilities: Record<string, Record<string, number>>;
}

export interface SpanLabels {
  version: 0;
  unit: string;
  classifier: string;
  questions: SpanLabelQuestion[];
  spans: LabelledSpan[];
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** A run of a content part's text: a labelled span, or the unlabelled text
 *  between spans. */
export interface TextSegment {
  text: string;
  span?: LabelledSpan;
}

/** The raw `span_labels` value of the first score that carries one. */
export const findSpanLabels = (
  scores: Record<string, Score> | null | undefined
): unknown => {
  for (const score of Object.values(scores ?? {})) {
    const metadata: unknown = score.metadata;
    if (isRecord(metadata) && Object.hasOwn(metadata, kSpanLabelsKey)) {
      return metadata[kSpanLabelsKey];
    }
  }
  return undefined;
};

export interface LoadedSpanLabels {
  labels: SpanLabels;
  spansByPart: Map<string, LabelledSpan[]>;
}

/** The sample's span labels, validated against its messages: undefined when
 *  no score carries any, an error when they are malformed. */
export const loadSpanLabels = (
  scores: Record<string, Score> | null | undefined,
  messages: readonly ChatMessage[]
): Parsed<LoadedSpanLabels> | undefined => {
  const raw = findSpanLabels(scores);
  if (raw === undefined) return undefined;
  const parsed = parseSpanLabels(raw);
  if (!parsed.ok) return parsed;
  const error = checkSpanTargets(parsed.value, messages);
  if (error !== undefined) return fail(error);
  return {
    ok: true,
    value: {
      labels: parsed.value,
      spansByPart: groupSpansByPart(parsed.value.spans),
    },
  };
};

const warned = new Set<string>();

/** Logs each distinct span-label problem once rather than on every render. */
export const warnSpanLabels = (error: string): void => {
  if (warned.has(error)) return;
  warned.add(error);
  console.warn(`Span labels not shown: ${error}`);
};

/** Validates the `span_labels` shape: every label is one of its question's
 *  options, every span is non-empty, and spans in one content part don't
 *  overlap. */
export const parseSpanLabels = (raw: unknown): Parsed<SpanLabels> => {
  if (!isRecord(raw)) return fail("span_labels is not an object");
  if (raw["version"] !== 0) {
    return fail(`unsupported version ${String(raw["version"])}`);
  }
  const unit = raw["unit"];
  const classifier = raw["classifier"];
  if (typeof unit !== "string") return fail("unit is not a string");
  if (typeof classifier !== "string") return fail("classifier is not a string");

  const questions = parseQuestions(raw["questions"]);
  if (!questions.ok) return questions;
  const byName = new Map(questions.value.map((q) => [q.name, q]));

  const rawSpans = raw["spans"];
  if (!Array.isArray(rawSpans)) return fail("spans is not an array");
  const spans: LabelledSpan[] = [];
  for (const [i, rawSpan] of rawSpans.entries()) {
    const span = parseSpan(rawSpan, byName);
    if (!span.ok) return fail(`spans[${i}]: ${span.error}`);
    spans.push(span.value);
  }

  for (const [key, partSpans] of groupSpansByPart(spans)) {
    for (let i = 1; i < partSpans.length; i++) {
      const prev = partSpans[i - 1];
      const next = partSpans[i];
      if (prev && next && next.start < prev.end) {
        return fail(
          `spans overlap in ${key}: [${prev.start}, ${prev.end}) and [${next.start}, ${next.end})`
        );
      }
    }
  }

  return {
    ok: true,
    value: { version: 0, unit, classifier, questions: questions.value, spans },
  };
};

/** Checks that every span points at a reasoning or text part of a message in
 *  `messages`, and that its offsets fall inside that part's text. */
export const checkSpanTargets = (
  labels: SpanLabels,
  messages: readonly ChatMessage[]
): string | undefined => {
  const byId = new Map(messages.map((m) => [m.id, m]));
  for (const [key, spans] of groupSpansByPart(labels.spans)) {
    const first = spans[0];
    const last = spans[spans.length - 1];
    if (!first || !last) continue;
    const message = byId.get(first.message_id);
    if (!message) return `message ${first.message_id} not found`;
    const text = partText(message, first.content_index);
    if (text === undefined) {
      return `${key} is not a reasoning or text content part`;
    }
    const length = Array.from(text).length;
    if (last.end > length) {
      return `${key}: span end ${last.end} is past the text's ${length} code points`;
    }
  }
  return undefined;
};

/** Spans grouped by content part (see `partKey`), each group sorted by
 *  start offset. */
export const groupSpansByPart = (
  spans: readonly LabelledSpan[]
): Map<string, LabelledSpan[]> => {
  const groups = new Map<string, LabelledSpan[]>();
  for (const span of spans) {
    const key = partKey(span.message_id, span.content_index);
    const group = groups.get(key);
    if (group) {
      group.push(span);
    } else {
      groups.set(key, [span]);
    }
  }
  for (const group of groups.values()) {
    group.sort((a, b) => a.start - b.start);
  }
  return groups;
};

export const partKey = (messageId: string, contentIndex: number): string =>
  `${messageId}[${contentIndex}]`;

/** Identifies one labelled paragraph, e.g. as a DOM attribute value. */
export const spanKey = (span: LabelledSpan): string =>
  `${span.message_id}:${span.content_index}:${span.start}`;

/** The reasoning parts of `message` that have labelled spans, keyed by the
 *  part object: renderers receive parts after content normalization and
 *  turn segmentation, which keep each part's identity but not its index. */
export const labelledReasoningParts = (
  spansByPart: ReadonlyMap<string, readonly LabelledSpan[]>,
  message: ChatMessage
): ReadonlyMap<ContentReasoning, readonly LabelledSpan[]> | undefined => {
  if (!message.id || typeof message.content === "string") return undefined;
  const parts = new Map<ContentReasoning, readonly LabelledSpan[]>();
  for (const [index, part] of message.content.entries()) {
    const spans = spansByPart.get(partKey(message.id, index));
    if (part.type === "reasoning" && spans) parts.set(part, spans);
  }
  return parts.size > 0 ? parts : undefined;
};

/** Cuts `text` into labelled spans and the unlabelled runs between them.
 *  Offsets are code points, so the text is split with `Array.from` rather
 *  than sliced by UTF-16 index. Whitespace-only runs between spans are
 *  dropped. `spans` must be sorted and non-overlapping. */
export const segmentText = (
  text: string,
  spans: readonly LabelledSpan[]
): Parsed<TextSegment[]> => {
  const codePoints = Array.from(text);
  const segments: TextSegment[] = [];
  const pushGap = (from: number, to: number) => {
    const gap = codePoints.slice(from, to).join("");
    if (gap.trim()) segments.push({ text: gap });
  };

  let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor) {
      return fail(`span [${span.start}, ${span.end}) overlaps the previous`);
    }
    if (span.end > codePoints.length) {
      return fail(
        `span end ${span.end} is past the text's ${codePoints.length} code points`
      );
    }
    pushGap(cursor, span.start);
    segments.push({
      text: codePoints.slice(span.start, span.end).join(""),
      span,
    });
    cursor = span.end;
  }
  pushGap(cursor, codePoints.length);
  return { ok: true, value: segments };
};

/** How many spans carry each option of `question` (options in question
 *  order, including zero counts). */
export const countLabels = (
  labels: SpanLabels,
  question: SpanLabelQuestion
): Array<{ option: string; count: number }> =>
  question.options.map((option) => ({
    option,
    count: labels.spans.filter((s) => s.labels[question.name] === option)
      .length,
  }));

/** Whether a span is dimmed by the legend's highlight: only when some
 *  options are highlighted and its colour-by label is not one of them. */
export const isDimmed = (
  highlighted: readonly string[],
  colorBy: SpanLabelQuestion,
  span: LabelledSpan | undefined
): boolean => {
  if (highlighted.length === 0) return false;
  const label = span?.labels[colorBy.name];
  return label === undefined || !highlighted.includes(label);
};

export const isYesNoQuestion = (question: SpanLabelQuestion): boolean =>
  question.options.length === 2 &&
  question.options.includes("yes") &&
  question.options.includes("no");

const kPaletteSize = 8;

/** How an option is drawn: a palette colour, hollow (dashed border, ring
 *  swatch) for options past the palette's eight hues. */
export interface OptionMark {
  color: string;
  hollow: boolean;
}

/** The mark for an option, stable by its index in the question's options.
 *  Yes/no questions get a strong colour for "yes" and neutral grey for "no".
 *  Options 9 and up reuse the palette's hues hollow rather than inventing
 *  new hues. */
export const optionMark = (
  question: SpanLabelQuestion,
  option: string | undefined
): OptionMark => {
  const neutral = { color: "var(--inspect-span-label-none)", hollow: false };
  if (option === undefined) return neutral;
  if (isYesNoQuestion(question)) {
    return option === "yes"
      ? { color: "var(--inspect-span-label-yes)", hollow: false }
      : neutral;
  }
  const index = question.options.indexOf(option);
  if (index < 0 || index >= 2 * kPaletteSize) return neutral;
  return {
    color: `var(--inspect-span-label-${(index % kPaletteSize) + 1})`,
    hollow: index >= kPaletteSize,
  };
};

/** A bare "yes" or "no" says nothing on its own, so those labels carry
 *  their question's name. */
export const labelText = (
  question: SpanLabelQuestion,
  label: string
): string =>
  label === "yes" || label === "no" ? `${question.name}: ${label}` : label;

const parseQuestions = (raw: unknown): Parsed<SpanLabelQuestion[]> => {
  if (!Array.isArray(raw) || raw.length === 0) {
    return fail("questions is not a non-empty array");
  }
  const questions: SpanLabelQuestion[] = [];
  for (const [i, q] of raw.entries()) {
    if (!isRecord(q)) return fail(`questions[${i}] is not an object`);
    const name = q["name"];
    const description = q["description"] ?? null;
    const options = q["options"];
    if (typeof name !== "string" || !name) {
      return fail(`questions[${i}].name is not a string`);
    }
    if (description !== null && typeof description !== "string") {
      return fail(`questions[${i}].description is not a string`);
    }
    if (!isStringArray(options) || options.length === 0) {
      return fail(`questions[${i}].options is not a list of strings`);
    }
    if (questions.some((other) => other.name === name)) {
      return fail(`question ${name} is defined twice`);
    }
    questions.push({ name, description, options });
  }
  return { ok: true, value: questions };
};

const parseSpan = (
  raw: unknown,
  questions: ReadonlyMap<string, SpanLabelQuestion>
): Parsed<LabelledSpan> => {
  if (!isRecord(raw)) return fail("not an object");
  const messageId = raw["message_id"];
  const contentIndex = raw["content_index"];
  const start = raw["start"];
  const end = raw["end"];
  if (typeof messageId !== "string" || !messageId) {
    return fail("message_id is not a string");
  }
  if (!isNonNegativeInt(contentIndex)) {
    return fail("content_index is not a non-negative integer");
  }
  if (!isNonNegativeInt(start) || !isNonNegativeInt(end) || end <= start) {
    return fail(`invalid offsets [${String(start)}, ${String(end)})`);
  }

  const rawLabels = raw["labels"];
  if (!isRecord(rawLabels)) return fail("labels is not an object");
  const labels: Record<string, string> = {};
  for (const [name, value] of Object.entries(rawLabels)) {
    const question = questions.get(name);
    if (!question) return fail(`label for unknown question ${name}`);
    if (typeof value !== "string" || !question.options.includes(value)) {
      return fail(`label ${name}=${String(value)} is not one of its options`);
    }
    labels[name] = value;
  }

  const rawProbabilities = raw["probabilities"] ?? {};
  if (!isRecord(rawProbabilities))
    return fail("probabilities is not an object");
  const probabilities: Record<string, Record<string, number>> = {};
  for (const [name, dist] of Object.entries(rawProbabilities)) {
    const question = questions.get(name);
    if (!question) return fail(`probabilities for unknown question ${name}`);
    if (!isRecord(dist)) return fail(`probabilities.${name} is not an object`);
    const parsed: Record<string, number> = {};
    for (const [option, p] of Object.entries(dist)) {
      if (!question.options.includes(option)) {
        return fail(`probabilities.${name} has unknown option ${option}`);
      }
      if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) {
        return fail(`probabilities.${name}.${option} is not in [0, 1]`);
      }
      parsed[option] = p;
    }
    probabilities[name] = parsed;
  }

  return {
    ok: true,
    value: {
      message_id: messageId,
      content_index: contentIndex,
      start,
      end,
      labels,
      probabilities,
    },
  };
};

/** The text that span offsets index into: `reasoning` for a reasoning part,
 *  `text` for a text part. */
export const partText = (
  message: ChatMessage,
  contentIndex: number
): string | undefined => {
  if (typeof message.content === "string") return undefined;
  const part = message.content[contentIndex];
  if (part?.type === "reasoning") return part.reasoning;
  if (part?.type === "text") return part.text;
  return undefined;
};

const isNonNegativeInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === "string");

const fail = (error: string): { ok: false; error: string } => ({
  ok: false,
  error,
});
