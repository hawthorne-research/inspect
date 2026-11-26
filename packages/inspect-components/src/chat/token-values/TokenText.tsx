import clsx from "clsx";
import { FC, ReactNode } from "react";

import { kPartAttribute, kTokenAttribute } from "./tokenDom";
import { tokenStyle } from "./tokenScale";
import styles from "./TokenText.module.css";
import type { TokenPart } from "./tokenValues";

interface TokenTextProps {
  part: TokenPart;
  probe: string;
  scale: number;
  monospace?: boolean;
}

/**
 * A content part's raw text with each token's background coloured by its
 * value. Raw rather than markdown: token offsets index the raw text, which
 * is also what the probe saw.
 */
export const TokenText: FC<TokenTextProps> = ({
  part,
  probe,
  scale,
  monospace,
}) => (
  <div
    {...{ [kPartAttribute]: part.index }}
    className={clsx(styles.tokens, monospace && styles.monospace)}
  >
    {tokenPieces(part, part.values[probe] ?? [], scale)}
  </div>
);

const tokenPieces = (
  part: TokenPart,
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
        {...{ [kTokenAttribute]: i }}
        style={tokenStyle(values[i] ?? 0, scale)}
      >
        {text.slice(start, end)}
      </span>
    );
    cursor = end;
  }
  if (cursor < text.length) pieces.push(text.slice(cursor));
  return pieces;
};
