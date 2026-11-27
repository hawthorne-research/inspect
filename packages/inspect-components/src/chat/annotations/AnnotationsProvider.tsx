import { FC, ReactNode } from "react";

import type { ChatMessage } from "@tsmono/inspect-common/types";

import { MessagePartRendererContext, type MessagePartRenderer } from "..";

import { AnnotatedPart } from "./AnnotatedPart";
import { chatPartFinder, hasAnnotatedPart } from "./chatParts";
import { AnnotationsContext } from "./context";
import type { AnnotationView, ResolvedLayer } from "./model";

/**
 * Draws `view`'s layer on the chat views inside, which show `messages`:
 * annotated parts render through `AnnotatedPart`, and messages holding
 * them start expanded. Without a view the chat renders as usual.
 */
export const AnnotationsProvider: FC<{
  view: AnnotationView | undefined;
  /** The sample's messages, which the layer was resolved against. */
  messages: readonly ChatMessage[];
  children: ReactNode;
}> = ({ view, messages, children }) => {
  // Built without the field or highlight, so changing those re-renders
  // annotated parts rather than every chat message.
  const layer = view?.layer;
  const renderer = layer ? layerPartRenderer(layer, messages) : undefined;
  return (
    <AnnotationsContext.Provider value={view}>
      <MessagePartRendererContext.Provider value={renderer}>
        {children}
      </MessagePartRendererContext.Provider>
    </AnnotationsContext.Provider>
  );
};

const layerPartRenderer = (
  layer: ResolvedLayer,
  messages: readonly ChatMessage[]
): MessagePartRenderer => {
  const find = chatPartFinder(layer, messages);
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
