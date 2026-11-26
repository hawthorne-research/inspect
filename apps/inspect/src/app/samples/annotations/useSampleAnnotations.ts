import { RefObject, useState } from "react";

import type { ChatMessage, EvalSample } from "@tsmono/inspect-common/types";
import {
  buildMessageRows,
  countRowBlocks,
  kMergedSystemMessageId,
  type ChatViewListHandle,
} from "@tsmono/inspect-components/chat";
import {
  annotationView,
  buildStrip,
  collectAnnotationLayers,
  colorScheme,
  flashSpan,
  spanSelector,
  stepColorScheme,
  warnAnnotations,
  type AnnotationView,
  type ResolvedLayer,
  type SpanLocation,
  type StripSegment,
} from "@tsmono/inspect-components/chat/annotations";
import { useProperty } from "@tsmono/react/hooks";

import { kDefaultMessageRowOptions } from "../../../log_data";

import { scrollToSpan } from "./scrollToSpan";
import { useDarkTheme } from "./useDarkTheme";

const kSelectionBag = "sample-annotations";
const kNoHighlight: readonly string[] = [];

export interface SampleAnnotations {
  view: AnnotationView;
  layers: readonly ResolvedLayer[];
  strip: readonly StripSegment[];
  setLayer: (id: string) => void;
  setField: (name: string) => void;
  toggleHighlight: (option: string) => void;
  clearHighlight: () => void;
  /** Scrolls the messages list to a span and flashes it. */
  focusSpan: (location: SpanLocation) => void;
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
 * Owns the text-annotation concern for a sample: collects the layers its
 * scores carry, validated against its messages (problems are logged and
 * leave the other layers usable), and tracks the layer and field on
 * screen, the highlighted options, and focusing a span from the strip.
 * Undefined when the sample has no valid layer.
 */
export function useSampleAnnotations(
  sample: EvalSample | undefined,
  targets: AnnotationTargets
): SampleAnnotations | undefined {
  // Kept across samples (and remounts), so moving between samples keeps
  // the layer and field wherever the next sample has them.
  const [layerId, setLayer] = useProperty<string>(kSelectionBag, "layer");
  const [fieldNames, setFieldNames] = useProperty<Record<string, string>>(
    kSelectionBag,
    "fields"
  );
  const [schemeId, setSchemeId] = useProperty<string>(kSelectionBag, "scheme");
  const palette = { scheme: colorScheme(schemeId), dark: useDarkTheme() };
  const [highlight, setHighlight] = useState<{
    layer: string;
    field: string;
    options: string[];
  }>({ layer: "", field: "", options: [] });

  const collected = sample
    ? collectAnnotationLayers(sample.scores, sample.messages)
    : undefined;
  for (const error of collected?.errors ?? []) warnAnnotations(error);
  const layers = collected?.layers ?? [];
  // Derived rather than synced: a stored choice this sample doesn't have
  // falls back to the first layer and field.
  const layer = layers.find((l) => l.id === layerId) ?? layers[0];
  if (!sample || !layer) return undefined;
  const fieldName = fieldNames?.[layer.id];
  const field =
    layer.fields.find((f) => f.name === fieldName) ?? layer.fields[0];
  if (!field) return undefined;

  const view = annotationView(
    layer,
    field,
    highlight.layer === layer.id && highlight.field === field.name
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
    const part = layer.parts[location.part];
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

  return {
    view,
    layers,
    strip,
    setLayer,
    setField: (name) => setFieldNames({ ...fieldNames, [layer.id]: name }),
    toggleHighlight: (option) =>
      setHighlight({
        layer: layer.id,
        field: field.name,
        options: highlighted.includes(option)
          ? highlighted.filter((o) => o !== option)
          : [...highlighted, option],
      }),
    clearHighlight: () => setHighlight({ layer: "", field: "", options: [] }),
    focusSpan,
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
