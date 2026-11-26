import { RefObject, useState } from "react";

import type { ChatMessage, EvalSample } from "@tsmono/inspect-common/types";
import {
  binTokens,
  buildMessageRows,
  countRowBlocks,
  flashToken,
  kMergedSystemMessageId,
  loadTokenValues,
  tokenScale,
  tokenSelector,
  warnTokenValues,
  type ChatViewListHandle,
  type TokenStripBin,
  type TokenValuesView,
} from "@tsmono/inspect-components/chat";

import { kDefaultMessageRowOptions } from "../../../log_data";
import { scrollToSpan } from "../span-labels/scrollToSpan";

export interface SampleTokenValues {
  view: TokenValuesView;
  bins: TokenStripBin[];
  setProbe: (name: string) => void;
  /** Scrolls the messages list to a bin's peak token and flashes it. */
  focusBin: (bin: TokenStripBin) => void;
}

interface TokenValuesTargets {
  list: RefObject<ChatViewListHandle | null>;
  scroller: RefObject<HTMLElement | null>;
  /** The sticky legend, whose bottom edge a focused token lands under. */
  legend: RefObject<HTMLElement | null>;
}

/**
 * Owns the token-heatmap concern for a sample: reads the probes'
 * `token_values` score metadata, validates it against the sample's
 * messages, tracks the selected probe and derives its colour scale and the
 * legend's overview strip. Undefined when the sample has no token values
 * or they fail validation (logged).
 */
export function useSampleTokenValues(
  sample: EvalSample | undefined,
  targets: TokenValuesTargets
): SampleTokenValues | undefined {
  const [probeName, setProbe] = useState("");

  const loaded = sample
    ? loadTokenValues(sample.scores, sample.messages)
    : undefined;
  if (loaded && !loaded.ok) {
    warnTokenValues(loaded.error);
  }
  if (!sample || !loaded?.ok) return undefined;

  const values = loaded.value;
  // Derived rather than synced: a stored choice this sample doesn't have
  // falls back to the first probe.
  const probe =
    values.probes.find((p) => p.name === probeName) ?? values.probes[0];
  if (!probe) return undefined;

  const sequences = values.parts.map((part) => part.values[probe.name] ?? []);
  const scale = tokenScale(sequences);
  const numbers = messageNumbers(sample.messages);
  const bins = binTokens(sequences).flatMap((bin): TokenStripBin[] => {
    const part = values.parts[bin.sequence];
    if (!part) return [];
    const messageNumber =
      numbers.get(part.messageId) ??
      sample.messages.findIndex((m) => m.id === part.messageId) + 1;
    return [{ ...bin, part, messageNumber }];
  });

  const systemIds = new Set(
    sample.messages.flatMap((m) => (m.role === "system" && m.id ? [m.id] : []))
  );

  const focusBin = (bin: TokenStripBin) => {
    const list = targets.list.current;
    const scroller = targets.scroller.current;
    const legend = targets.legend.current;
    if (!list || !scroller || !legend) return;
    const land = (messageId: string) =>
      scrollToSpan({
        list,
        scroller,
        chrome: legend,
        messageId,
        selector: tokenSelector(bin.part.index, bin.token),
        onLanded: flashToken,
      });
    // System messages render folded into the list's one merged system row.
    const found =
      land(bin.part.messageId) ||
      (systemIds.has(bin.part.messageId) && land(kMergedSystemMessageId));
    if (!found) {
      console.warn(
        `Token values: message ${bin.part.messageId} is not loaded in the Messages list`
      );
    }
  };

  return {
    view: { values, probe, scale },
    bins,
    setProbe,
    focusBin,
  };
}

let spanLabelsHiddenNoted = false;

/** Notes once that a sample's paragraph labels are hidden because the
 *  Messages tab shows its token values instead. */
export const noteSpanLabelsHidden = (): void => {
  if (spanLabelsHiddenNoted) return;
  spanLabelsHiddenNoted = true;
  console.info(
    "Paragraph labels not shown: this sample also has token values, which take their place"
  );
};

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
