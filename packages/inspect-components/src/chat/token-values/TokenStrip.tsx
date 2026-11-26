import clsx from "clsx";
import { FC, MouseEvent, useState } from "react";

import { formatTokenValue, tokenStyle, type TokenBin } from "./tokenScale";
import styles from "./TokenStrip.module.css";
import { tokenText, type TokenPart } from "./tokenValues";

const kTooltipWidth = 280;

/** A bin of the overview strip, located in the transcript. */
export interface TokenStripBin extends TokenBin {
  /** The part holding the bin's peak token. */
  part: TokenPart;
  /** The number on the peak token's message chip in the Messages tab. */
  messageNumber: number;
}

interface TokenStripProps {
  bins: readonly TokenStripBin[];
  scale: number;
  onSelect: (bin: TokenStripBin) => void;
}

/**
 * Every token in transcript order, binned and coloured by each bin's peak.
 * Hovering shows the peak; clicking asks the host to scroll to its token.
 */
export const TokenStrip: FC<TokenStripProps> = ({ bins, scale, onSelect }) => {
  const [hover, setHover] = useState<{ index: number; left: number } | null>(
    null
  );
  const hovered = hover ? bins[hover.index] : undefined;

  const showTooltip = (index: number, e: MouseEvent<HTMLButtonElement>) => {
    const target = e.currentTarget;
    const stripWidth =
      target.offsetParent instanceof HTMLElement
        ? target.offsetParent.clientWidth
        : 0;
    const center = target.offsetLeft + target.offsetWidth / 2;
    const left = Math.max(
      0,
      Math.min(center - kTooltipWidth / 2, stripWidth - kTooltipWidth)
    );
    setHover({ index, left });
  };

  return (
    <div className={styles.strip} onMouseLeave={() => setHover(null)}>
      <div
        className={styles.bins}
        role="group"
        aria-label="Token values in transcript order"
      >
        {bins.map((bin, index) => (
          <button
            key={index}
            type="button"
            // Hundreds of bins would swamp the tab order.
            tabIndex={-1}
            aria-label={`Peak ${formatTokenValue(bin.peak)}, message ${bin.messageNumber}`}
            className={clsx(
              styles.bin,
              hover?.index === index && styles.hovered
            )}
            style={tokenStyle(bin.peak, scale)}
            onMouseEnter={(e) => showTooltip(index, e)}
            onClick={() => onSelect(bin)}
          />
        ))}
      </div>
      {hover && hovered ? (
        <div
          className={styles.tooltip}
          style={{ left: hover.left, width: kTooltipWidth }}
          role="tooltip"
        >
          <div className={styles.tooltipHeader}>
            <span
              className={styles.swatch}
              style={tokenStyle(hovered.peak, scale)}
            />
            <span className={styles.peak}>
              peak {formatTokenValue(hovered.peak)}
            </span>
            <span className={styles.message}>
              message {hovered.messageNumber}
            </span>
          </div>
          <div className={styles.token}>
            {JSON.stringify(tokenText(hovered.part, hovered.token))}
          </div>
          <div className={styles.count}>
            {hovered.count} {hovered.count === 1 ? "token" : "tokens"} in bin
          </div>
        </div>
      ) : null}
    </div>
  );
};
