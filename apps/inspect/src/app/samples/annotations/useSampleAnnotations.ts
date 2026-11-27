import { RefObject, useState } from "react";

import type { ChatMessage, EvalSample } from "@tsmono/inspect-common/types";
import {
  buildMessageRows,
  countRowBlocks,
  kMergedSystemMessageId,
  rowContainsMessage,
  type ChatViewListHandle,
  type MessageRow,
} from "@tsmono/inspect-components/chat";
import {
  flashSpan,
  spanSelector,
} from "@tsmono/inspect-components/chat/annotations";
import {
  annotationView,
  buildStrip,
  collectAnnotationSets,
  colorScheme,
  locateSpan,
  stepColorScheme,
  warnAnnotations,
  type AnnotationView,
  type ResolvedSet,
  type SpanLocation,
  type StripSegment,
} from "@tsmono/inspect-components/chat/annotations/model";
import { useProperty } from "@tsmono/react/hooks";

import { kDefaultMessageRowOptions } from "../../../log_data";
import type { SpanTarget } from "../../routing/url";

import { scrollToSpan } from "./scrollToSpan";
import { useDarkTheme } from "./useDarkTheme";

const kSelectionBag = "sample-annotations";
const kNoHighlight: readonly string[] = [];

/** The annotation colour scheme's id and its setter: one choice for every
 *  view of annotations, kept across samples and logs. */
export const useAnnotationScheme = () =>
  useProperty<string>(kSelectionBag, "scheme");

export interface SampleAnnotations {
  view: AnnotationView;
  sets: readonly ResolvedSet[];
  strip: readonly StripSegment[];
  selectSet: (id: string) => void;
  setField: (name: string) => void;
  toggleHighlight: (option: string) => void;
  clearHighlight: () => void;
  /** Scrolls the messages list to a span and flashes it. */
  focusSpan: (location: SpanLocation) => void;
  /**
   * One step of landing a deep link on its span (see `useAttemptUntilDone`):
   * true once it has focused the span, or found it can't be shown; false to
   * be called again, while `rows` lack its message or after switching to
   * the target's annotation set because the set on screen has no span
   * there.
   */
  landOnSpan: (target: SpanTarget, rows: readonly MessageRow[]) => boolean;
  /** Moves to the next colour scheme (`step` 1) or the previous (-1). */
  cycleScheme: (step: 1 | -1) => void;
}

interface AnnotationTargets {
  list: RefObject<ChatViewListHandle | null>;
  scroller: RefObject<HTMLElement | null>;
  /** The sticky legend, whose bottom edge a focused span lands under. */
  legend: RefObject<HTMLElement | null>;
}

/**
 * Owns the text-annotation concern for a sample: collects the annotation
 * sets its scores carry, validated against its messages (problems are
 * logged and leave the other sets usable), and tracks the set and field on
 * screen, the highlighted options, and focusing a span from the strip.
 * Undefined when the sample has no valid annotation set.
 */
export function useSampleAnnotations(
  sample: EvalSample | undefined,
  targets: AnnotationTargets
): SampleAnnotations | undefined {
  // Kept across samples (and remounts), so moving between samples keeps
  // the annotation set and field wherever the next sample has them.
  const [chosenSetId, selectSet] = useProperty<string>(kSelectionBag, "set");
  const [fieldNames, setFieldNames] = useProperty<Record<string, string>>(
    kSelectionBag,
    "fields"
  );
  const [schemeId, setSchemeId] = useAnnotationScheme();
  const palette = { scheme: colorScheme(schemeId), dark: useDarkTheme() };
  const [highlight, setHighlight] = useState<{
    set: string;
    field: string;
    options: string[];
  }>({ set: "", field: "", options: [] });

  const collected = sample
    ? collectAnnotationSets(sample.scores, sample.messages)
    : undefined;
  for (const error of collected?.errors ?? []) warnAnnotations(error);
  const sets = collected?.sets ?? [];
  // Derived rather than synced: a stored choice this sample doesn't have
  // falls back to the first annotation set and field.
  const set = sets.find((s) => s.id === chosenSetId) ?? sets[0];
  if (!sample || !set) return undefined;
  const fieldName = fieldNames?.[set.id];
  const field = set.fields.find((f) => f.name === fieldName) ?? set.fields[0];
  if (!field) return undefined;

  const view = annotationView(
    set,
    field,
    highlight.set === set.id && highlight.field === field.name
      ? highlight.options
      : kNoHighlight,
    palette
  );
  const { highlighted } = view;
  const strip = buildStrip(view, messageNumbers(sample.messages));
  const systemIds = new Set(
    sample.messages.flatMap((m) => (m.role === "system" && m.id ? [m.id] : []))
  );

  const focusSpan = (location: SpanLocation) => {
    const list = targets.list.current;
    const scroller = targets.scroller.current;
    const legend = targets.legend.current;
    const part = set.parts[location.part];
    if (!list || !scroller || !legend || !part) return;
    const land = (messageId: string) =>
      scrollToSpan({
        list,
        scroller,
        chrome: legend,
        messageId,
        selector: spanSelector(location),
        onLanded: flashSpan,
      });
    // System messages render folded into the list's one merged system row.
    const found =
      land(part.messageId) ||
      (systemIds.has(part.messageId) && land(kMergedSystemMessageId));
    if (!found) {
      console.warn(
        `Text annotations: message ${part.messageId} is not loaded in the Messages list`
      );
    }
  };

  const rendered = (rows: readonly MessageRow[], messageId: string) =>
    rows.some(
      (row) =>
        rowContainsMessage(row, messageId) ||
        (systemIds.has(messageId) &&
          row.resolved.message.id === kMergedSystemMessageId)
    );

  const landOnSpan = (
    target: SpanTarget,
    rows: readonly MessageRow[]
  ): boolean => {
    const location = locateSpan(set, target.position);
    if (!location) {
      const other = sets.find((s) => s.id === target.set);
      if (other && locateSpan(other, target.position)) {
        selectSet(other.id);
        return false;
      }
      warnAnnotations(
        `no annotation set has the linked span ${JSON.stringify(target)}`
      );
      return true;
    }
    if (!rendered(rows, target.position.messageId) || !targets.list.current) {
      return false;
    }
    focusSpan(location);
    return true;
  };

  return {
    view,
    sets,
    strip,
    selectSet,
    setField: (name) => setFieldNames({ ...fieldNames, [set.id]: name }),
    toggleHighlight: (option) =>
      setHighlight({
        set: set.id,
        field: field.name,
        options: highlighted.includes(option)
          ? highlighted.filter((o) => o !== option)
          : [...highlighted, option],
      }),
    clearHighlight: () => setHighlight({ set: "", field: "", options: [] }),
    focusSpan,
    landOnSpan,
    cycleScheme: (step) =>
      setSchemeId(stepColorScheme(palette.scheme, step).id),
  };
}

/**
 * The number on each message's chip in the Messages tab, which folds the
 * same messages with the same row options: a row's message takes its first
 * number unless only its tool calls render, each tool call (and so its tool
 * message) the numbers after it, and every system message the merged
 * system row's number.
 */
const messageNumbers = (messages: ChatMessage[]): Map<string, number> => {
  const numbers = new Map<string, number>();
  for (const row of buildMessageRows(messages, kDefaultMessageRowOptions)) {
    const { message, toolMessages } = row.resolved;
    if (message.id === kMergedSystemMessageId) {
      for (const m of messages) {
        if (m.role === "system" && m.id) numbers.set(m.id, row.startNumber);
      }
      continue;
    }
    const toolCalls = message.role === "assistant" ? message.tool_calls : null;
    const calls = toolCalls ?? [];
    const messageBlocks =
      countRowBlocks(row.resolved, kDefaultMessageRowOptions.toolCallStyle) -
      calls.length;
    if (message.id && messageBlocks > 0) {
      numbers.set(message.id, row.startNumber);
    }
    for (const [index, call] of calls.entries()) {
      const toolMessage = call.id
        ? toolMessages.find((tm) => tm.tool_call_id === call.id)
        : toolMessages[index];
      if (toolMessage?.id) {
        numbers.set(toolMessage.id, row.startNumber + messageBlocks + index);
      }
    }
  }
  return numbers;
};
