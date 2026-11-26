import { FC, ReactNode } from "react";

import { MessagePartRendererContext, type MessagePartRenderer } from "..";

import { AnnotatedPart } from "./AnnotatedPart";
import { AnnotationsContext } from "./context";
import { findPart, hasAnnotatedPart, type ResolvedLayer } from "./layers";
import type { AnnotationView } from "./view";

/**
 * Draws `view`'s layer on the chat views inside: annotated parts render
 * through `AnnotatedPart`, and messages holding them start expanded.
 * Without a view the chat renders as usual.
 */
export const AnnotationsProvider: FC<{
  view: AnnotationView | undefined;
  children: ReactNode;
}> = ({ view, children }) => {
  // Built from the layer alone, so changing the field or highlight
  // re-renders annotated parts rather than every chat message.
  const layer = view?.layer;
  const renderer = layer ? layerPartRenderer(layer) : undefined;
  return (
    <AnnotationsContext.Provider value={view}>
      <MessagePartRendererContext.Provider value={renderer}>
        {children}
      </MessagePartRendererContext.Provider>
    </AnnotationsContext.Provider>
  );
};

const layerPartRenderer = (layer: ResolvedLayer): MessagePartRenderer => ({
  renderPart: (message, contentIndex, { toolOutput }) => {
    const part = findPart(layer, message, contentIndex);
    return part ? (
      <AnnotatedPart part={part} toolOutput={toolOutput} />
    ) : undefined;
  },
  startsExpanded: (message) => hasAnnotatedPart(layer, message),
});
