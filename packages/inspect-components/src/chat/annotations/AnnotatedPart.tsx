import clsx from "clsx";
import { FC } from "react";

import styles from "./AnnotatedPart.module.css";
import { useAnnotationView } from "./context";
import { LabelledText } from "./LabelledText";
import type { ResolvedPart } from "./layers";
import { ShadedText } from "./ShadedText";

interface AnnotatedPartProps {
  part: ResolvedPart;
  /** Drawn as a tool's output: monospace where the text is raw. */
  toolOutput: boolean;
}

/**
 * A content part drawn with the active layer's spans: labelled paragraphs
 * for a categorical field, shaded raw text for a numeric one. Reasoning
 * keeps its heading and frame.
 */
export const AnnotatedPart: FC<AnnotatedPartProps> = ({ part, toolOutput }) => {
  const view = useAnnotationView();
  const body = !view ? (
    <div className={styles.plain}>{part.text}</div>
  ) : view.field.type === "categorical" ? (
    <LabelledText part={part} view={view} field={view.field} />
  ) : (
    <ShadedText
      part={part}
      field={view.field}
      scale={view.scale}
      monospace={toolOutput}
    />
  );
  if (part.kind !== "reasoning") return body;
  return (
    <div
      data-content-kind="reasoning"
      className={clsx(styles.reasoning, "text-size-small")}
    >
      <div className={clsx("text-style-label", "text-style-secondary")}>
        Reasoning
      </div>
      {body}
    </div>
  );
};
