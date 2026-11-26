import clsx from "clsx";
import { FC, ReactNode } from "react";

import type { ChatMessageTool, Content } from "@tsmono/inspect-common/types";
import type { MarkdownReference } from "@tsmono/react/components";

import { MessageContent } from "../MessageContent";
import contentStyles from "../MessageContent.module.css";
import { ToolBlockOutput } from "../tools/ToolBlock";
import { ToolCallErrorView } from "../tools/ToolCallErrorView";
import { ToolOutput } from "../tools/ToolOutput";

import { TokenText } from "./TokenText";
import type { MessageTokenParts, TokenPart } from "./tokenValues";
import type { TokenValuesView } from "./TokenValuesContext";

interface TokenValuedContentProps {
  /** A message's content, or a run of it (a turn's prose segment). */
  contents: string | readonly Content[];
  parts: MessageTokenParts;
  view: TokenValuesView;
  references?: MarkdownReference[];
  /** Tool output: tokens in monospace, other parts as tool output. */
  tool?: boolean;
}

/**
 * Message content whose parts with token values render as token text; runs
 * of other parts render as they would without values.
 */
export const TokenValuedContent: FC<TokenValuedContentProps> = ({
  contents,
  parts,
  view,
  references,
  tool = false,
}) => {
  if (typeof contents === "string") {
    return parts.whole ? (
      <TokenPartView part={parts.whole} view={view} tool={tool} />
    ) : (
      <RestOfContent contents={contents} references={references} tool={tool} />
    );
  }
  return contentPieces(contents, parts, view, references, tool);
};

/** A tool call's output well, for a tool message with token values: its
 *  error (if any) and its content as token text. */
export const ToolTokenOutput: FC<{
  message: ChatMessageTool;
  parts: MessageTokenParts;
  view: TokenValuesView;
}> = ({ message, parts, view }) => (
  <ToolBlockOutput>
    {message.error ? <ToolCallErrorView error={message.error} /> : null}
    <TokenValuedContent
      contents={message.content}
      parts={parts}
      view={view}
      tool
    />
  </ToolBlockOutput>
);

const contentPieces = (
  contents: readonly Content[],
  parts: MessageTokenParts,
  view: TokenValuesView,
  references: MarkdownReference[] | undefined,
  tool: boolean
): ReactNode[] => {
  const pieces: ReactNode[] = [];
  let run: Content[] = [];
  const flush = () => {
    if (run.length === 0) return;
    pieces.push(
      <RestOfContent
        key={`rest-${pieces.length}`}
        contents={run}
        references={references}
        tool={tool}
      />
    );
    run = [];
  };
  for (const content of contents) {
    const part = parts.byPart.get(content);
    if (part) {
      flush();
      pieces.push(
        <TokenPartView
          key={`part-${part.index}`}
          part={part}
          view={view}
          tool={tool}
        />
      );
    } else {
      run.push(content);
    }
  }
  flush();
  return pieces;
};

const TokenPartView: FC<{
  part: TokenPart;
  view: TokenValuesView;
  tool: boolean;
}> = ({ part, view, tool }) => {
  const text = (
    <TokenText
      part={part}
      probe={view.probe.name}
      scale={view.scale}
      monospace={tool}
    />
  );
  if (part.kind !== "reasoning") return text;
  return (
    <div
      data-content-kind="reasoning"
      className={clsx(contentStyles.reasoning, "text-size-small")}
    >
      <div className={clsx("text-style-label", "text-style-secondary")}>
        Reasoning
      </div>
      {text}
    </div>
  );
};

const RestOfContent: FC<{
  contents: string | Content[];
  references: MarkdownReference[] | undefined;
  tool: boolean;
}> = ({ contents, references, tool }) =>
  tool ? (
    <ToolOutput
      output={
        typeof contents === "string"
          ? contents
          : contents.filter((c) => c.type !== "tool_use")
      }
    />
  ) : (
    <MessageContent contents={contents} references={references} />
  );
