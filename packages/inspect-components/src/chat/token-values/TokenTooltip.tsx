import clsx from "clsx";
import { FC, useState } from "react";

import { useEventListener } from "@tsmono/react/hooks";

import { hoveredToken, type HoveredToken } from "./tokenDom";
import { formatTokenValue, tokenStyle } from "./tokenScale";
import styles from "./TokenTooltip.module.css";
import { probeLabel, tokenText } from "./tokenValues";
import type { TokenValuesView } from "./TokenValuesContext";

const kWidth = 320;
const kColumnWidth = 180;
const kGap = 6;
// Longer probe lists wrap into more columns rather than a tall tooltip.
const kRowsPerColumn = 12;

/**
 * The one tooltip for every token in the Messages tab: listens for hover on
 * the document rather than on each of the sample's tokens, and hides on
 * scroll, which would leave it behind.
 */
export const TokenTooltip: FC<{ view: TokenValuesView }> = ({ view }) => {
  const [hover, setHover] = useState<HoveredToken | null>(null);
  useEventListener(document, "mouseover", (e) => {
    setHover(hoveredToken(e.target, view.values));
  });
  // No mouseover follows when the pointer leaves the window.
  useEventListener(document, "mouseout", (e) => {
    if (!e.relatedTarget) setHover(null);
  });
  useEventListener(document, "scroll", () => setHover(null), {
    capture: true,
    passive: true,
  });
  if (!hover) return null;

  const { part, token, rect } = hover;
  const value = part.values[view.probe.name]?.[token] ?? 0;
  const probes = view.values.probes;
  const columns = Math.ceil(probes.length / kRowsPerColumn);
  const width = Math.min(
    window.innerWidth - 2 * kGap,
    Math.max(kWidth, columns * kColumnWidth)
  );
  const left = Math.max(
    kGap,
    Math.min(rect.left, window.innerWidth - width - kGap)
  );
  const below = rect.bottom < window.innerHeight * 0.6;

  return (
    <div
      className={styles.tooltip}
      role="tooltip"
      style={{
        left,
        maxWidth: width,
        ...(below
          ? { top: rect.bottom + kGap }
          : { bottom: window.innerHeight - rect.top + kGap }),
      }}
    >
      <div className={styles.token}>
        {JSON.stringify(tokenText(part, token))}
      </div>
      <div className={styles.selected}>
        <span className={styles.swatch} style={tokenStyle(value, view.scale)} />
        <span className={styles.probe}>{probeLabel(view.probe)}</span>
        <span className={styles.value}>{formatTokenValue(value)}</span>
      </div>
      {probes.length > 1 ? (
        <div
          className={styles.table}
          style={{
            gridTemplateRows: `repeat(${Math.ceil(probes.length / columns)}, auto)`,
          }}
        >
          {probes.map((probe) => {
            const isSelected = probe.name === view.probe.name;
            const probeValue = part.values[probe.name]?.[token] ?? 0;
            return (
              <div
                key={probe.name}
                className={clsx(styles.row, isSelected && styles.current)}
              >
                <span className={styles.name}>{probeLabel(probe)}</span>
                <span className={styles.value}>
                  {formatTokenValue(probeValue)}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
};
