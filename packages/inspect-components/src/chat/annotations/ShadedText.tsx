import clsx from "clsx";
import { FC, ReactNode } from "react";

import { kPartAttribute, kSpanAttribute } from "./dom";
import type { NumericField } from "./format";
import type { ResolvedPart } from "./layers";
import { valueStyle } from "./numeric";
import styles from "./ShadedText.module.css";

interface ShadedTextProps {
  part: ResolvedPart;
  field: NumericField;
  scale: number;
  monospace?: boolean;
}

/**
 * A content part's raw text with each span's background coloured by its
 * value. Raw rather than markdown: span offsets index the raw text, which
 * is also what a probe saw.
 */
export const ShadedText: FC<ShadedTextProps> = ({
  part,
  field,
  scale,
  monospace,
}) => (
  <div
    {...{ [kPartAttribute]: part.index }}
    className={clsx(styles.text, monospace && styles.monospace)}
  >
    {shadedPieces(part, part.values.get(field.name) ?? [], scale)}
  </div>
);

const shadedPieces = (
  part: ResolvedPart,
  values: readonly number[],
  scale: number
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
        style={valueStyle(values[i] ?? 0, scale)}
      >
        {text.slice(start, end)}
      </span>
    );
    cursor = end;
  }
  if (cursor < text.length) pieces.push(text.slice(cursor));
  return pieces;
};
