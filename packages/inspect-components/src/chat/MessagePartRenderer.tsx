import { createContext, Fragment, ReactNode, useContext } from "react";

import type { Content } from "@tsmono/inspect-common/types";

import type { Message } from "./messages";

export interface PartRenderOptions {
  /** The part is drawn as a tool's output rather than as message text. */
  toolOutput: boolean;
}

/**
 * Lets the host of a chat view draw parts of message content itself (e.g.
 * text with annotations overlaid). Absent, every part renders as usual.
 */
export interface MessagePartRenderer {
  /** Draws part `contentIndex` of `message`, or `null` for a message whose
   *  content is a string; undefined leaves the part to the chat. */
  renderPart: (
    message: Message,
    contentIndex: number | null,
    options: PartRenderOptions
  ) => ReactNode | undefined;
  /** Whether `message` starts expanded rather than clipped to its first
   *  lines. */
  startsExpanded: (message: Message) => boolean;
}

export const MessagePartRendererContext = createContext<
  MessagePartRenderer | undefined
>(undefined);

export const useMessagePartRenderer = (): MessagePartRenderer | undefined =>
  useContext(MessagePartRendererContext);

/**
 * `contents` (a message's content, or a run of its parts) with the parts
 * `renderer` draws swapped in, and each run of the other parts drawn by
 * `renderRest`. Undefined when the renderer draws none of them, so the
 * caller keeps its usual rendering.
 */
export const renderMessageParts = (
  renderer: MessagePartRenderer | undefined,
  message: Message,
  contents: string | readonly Content[],
  options: PartRenderOptions,
  renderRest: (rest: Content[]) => ReactNode
): ReactNode[] | undefined => {
  if (!renderer) return undefined;
  if (typeof contents === "string") {
    const drawn = renderer.renderPart(message, null, options);
    return drawn === undefined
      ? undefined
      : [<Fragment key="content">{drawn}</Fragment>];
  }
  const parts = message.content;
  if (typeof parts === "string") return undefined;

  const pieces: ReactNode[] = [];
  let drawnAny = false;
  let run: Content[] = [];
  const flush = () => {
    if (run.length === 0) return;
    pieces.push(
      <Fragment key={`rest-${pieces.length}`}>{renderRest(run)}</Fragment>
    );
    run = [];
  };
  for (const content of contents) {
    // A turn's segments keep each part's identity but not its index.
    const index = parts.indexOf(content);
    const drawn =
      index < 0 ? undefined : renderer.renderPart(message, index, options);
    if (drawn === undefined) {
      run.push(content);
    } else {
      flush();
      pieces.push(<Fragment key={`part-${index}`}>{drawn}</Fragment>);
      drawnAny = true;
    }
  }
  if (!drawnAny) return undefined;
  flush();
  return pieces;
};
