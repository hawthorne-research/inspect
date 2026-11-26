import clsx from "clsx";
import { FC, ReactNode } from "react";

import styles from "./AnnotatedPart.module.css";
import { useAnnotationView } from "./context";
import { kPartAttribute, kSpanAttribute } from "./dom";
import type { ResolvedPart } from "./layers";
import { spanStyle, type AnnotationView } from "./view";

interface AnnotatedPartProps {
  part: ResolvedPart;
  /** Drawn as a tool's output: monospace. */
  toolOutput: boolean;
}

/**
 * A content part's raw text with each span's background coloured by the
 * active field. Raw rather than markdown: span offsets index the raw text,
 * which is also what a classifier or probe saw. Reasoning keeps its heading
 * and frame.
 */
export const AnnotatedPart: FC<AnnotatedPartProps> = ({ part, toolOutput }) => {
  const view = useAnnotationView();
  const body = (
    <div
      // A new layer's spans mount fresh: reconciling thousands of spans
      // into a few inserts them one at a time.
      key={view?.layer.id}
      {...{ [kPartAttribute]: part.index }}
      className={clsx(styles.text, toolOutput && styles.monospace)}
    >
      {view ? annotatedPieces(view, part) : part.text}
    </div>
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

const annotatedPieces = (
  view: AnnotationView,
  part: ResolvedPart
): ReactNode[] => {
  const { text, starts, ends } = part;
  const pieces: ReactNode[] = [];
  let cursor = 0;
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i] ?? cursor;
    const end = ends[i] ?? start;
    if (start > cursor) pieces.push(text.slice(cursor, start));
    pieces.push(
      <span
        key={i}
        {...{ [kSpanAttribute]: i }}
        style={spanStyle(view, part, i)}
      >
        {text.slice(start, end)}
      </span>
    );
    cursor = end;
  }
  if (cursor < text.length) pieces.push(text.slice(cursor));
  return pieces;
};
