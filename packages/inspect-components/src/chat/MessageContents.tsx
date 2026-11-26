import { FC } from "react";

import type {
  ChatMessageAssistant,
  ChatMessageSystem,
  ChatMessageTool,
  ChatMessageUser,
  ContentReasoning,
} from "@tsmono/inspect-common/types";
import type { MarkdownReference } from "@tsmono/react/components";

import { MessageContent } from "./MessageContent";
import type { LabelledSpan } from "./span-labels/spanLabels";

interface MessageContentsProps {
  message:
    | ChatMessageAssistant
    | ChatMessageSystem
    | ChatMessageUser
    | ChatMessageTool;
  references?: MarkdownReference[];
  reasoningSpans?: ReadonlyMap<ContentReasoning, readonly LabelledSpan[]>;
}

export const MessageContents: FC<MessageContentsProps> = ({
  message,
  references,
  reasoningSpans,
}) => {
  return (
    <>
      {message.content && (
        <MessageContent
          contents={message.content}
          references={references}
          reasoningSpans={reasoningSpans}
        />
      )}
    </>
  );
};
