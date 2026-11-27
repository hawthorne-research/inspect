import type { ChatMessage } from "@tsmono/inspect-common/types";

import { kMergedSystemMessageId, type Message } from "..";

import { partKey, type ResolvedLayer, type ResolvedPart } from "./model";

/** The part of a layer that annotates part `contentIndex` of `message` as
 *  the chat renders it, if any. */
export type ChatPartFinder = (
  message: Message,
  contentIndex: number | null
) => ResolvedPart | undefined;

/**
 * Finds `layer`'s parts by the chat's messages. The chat folds every system
 * message of `messages` into one merged row, whose content entries map back
 * to the system messages they came from.
 */
export const chatPartFinder = (
  layer: ResolvedLayer,
  messages: readonly ChatMessage[]
): ChatPartFinder => {
  const systemParts = mergedSystemParts(layer, messages);
  return (message, contentIndex) => {
    if (!message.id) return undefined;
    if (message.id !== kMergedSystemMessageId) {
      return layer.partsByKey.get(partKey(message.id, contentIndex));
    }
    if (
      contentIndex === null ||
      typeof message.content === "string" ||
      message.content.length !== systemParts.length
    ) {
      return undefined;
    }
    return systemParts[contentIndex];
  };
};

/** Whether any part of `message`, as the chat renders it, is annotated. */
export const hasAnnotatedPart = (
  find: ChatPartFinder,
  message: Message
): boolean => {
  if (typeof message.content === "string") {
    return find(message, null) !== undefined;
  }
  return message.content.some((_, index) => find(message, index) !== undefined);
};

/** One entry per content entry of the merged system row (a string content
 *  counts as one entry), mirroring `mergedSystemMessage`. */
const mergedSystemParts = (
  layer: ResolvedLayer,
  messages: readonly ChatMessage[]
): (ResolvedPart | undefined)[] =>
  messages.flatMap((message) => {
    if (message.role !== "system") return [];
    const id = message.id;
    if (typeof message.content === "string") {
      return [id ? layer.partsByKey.get(partKey(id, null)) : undefined];
    }
    return message.content.map((_, index) =>
      id ? layer.partsByKey.get(partKey(id, index)) : undefined
    );
  });
