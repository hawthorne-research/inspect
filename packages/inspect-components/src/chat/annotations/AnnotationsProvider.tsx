import { FC, ReactNode } from "react";

import type { ChatMessage } from "@tsmono/inspect-common/types";

import { MessagePartRendererContext, type MessagePartRenderer } from "..";

import { AnnotatedPart } from "./AnnotatedPart";
import { chatPartFinder, hasAnnotatedPart } from "./chatParts";
import { AnnotationsContext } from "./context";
import type { AnnotationView, ResolvedSet } from "./model";

/**
 * Draws `view`'s annotation set on the chat views inside, which show
 * `messages`: annotated parts render through `AnnotatedPart`, and messages
 * holding them start expanded. Without a view the chat renders as usual.
 */
export const AnnotationsProvider: FC<{
  view: AnnotationView | undefined;
  /** The sample's messages, which the set was resolved against. */
  messages: readonly ChatMessage[];
  children: ReactNode;
}> = ({ view, messages, children }) => {
  // Built without the field or highlight, so changing those re-renders
  // annotated parts rather than every chat message.
  const set = view?.set;
  const renderer = set ? setPartRenderer(set, messages) : undefined;
  return (
    <AnnotationsContext.Provider value={view}>
      <MessagePartRendererContext.Provider value={renderer}>
        {children}
      </MessagePartRendererContext.Provider>
    </AnnotationsContext.Provider>
  );
};

const setPartRenderer = (
  set: ResolvedSet,
  messages: readonly ChatMessage[]
): MessagePartRenderer => {
  const find = chatPartFinder(set, messages);
  return {
    renderPart: (message, contentIndex, { toolOutput }) => {
      const part = find(message, contentIndex);
      return part ? (
        <AnnotatedPart part={part} toolOutput={toolOutput} />
      ) : undefined;
    },
    startsExpanded: (message) => hasAnnotatedPart(find, message),
  };
};
