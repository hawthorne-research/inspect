import clsx from "clsx";
import { FC, MouseEvent, useState } from "react";

import { spanCountLabel, type SpanLocation, type StripSegment } from "./model";
import styles from "./OverviewStrip.module.css";
import { Swatch } from "./Swatch";

const kTooltipWidth = 320;

interface OverviewStripProps {
  segments: readonly StripSegment[];
  /** What one span is, e.g. "token". */
  unit: string;
  onSelect: (location: SpanLocation) => void;
}

/**
 * The layer's spans in transcript order, one segment per span or per run
 * of spans, coloured like the span each shows. Hovering shows that span;
 * clicking asks the host to scroll to it.
 */
export const OverviewStrip: FC<OverviewStripProps> = ({
  segments,
  unit,
  onSelect,
}) => {
  const [hover, setHover] = useState<{ index: number; left: number } | null>(
    null
  );
  const show = (index: number, e: MouseEvent<HTMLButtonElement>) => {
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
  const hovered = hover ? segments[hover.index] : undefined;
  return (
    <div className={styles.strip} onMouseLeave={() => setHover(null)}>
      <div
        className={styles.items}
        role="group"
        aria-label="Spans in transcript order"
      >
        {segments.map((segment, index) => (
          <button
            key={index}
            type="button"
            // Hundreds of segments would swamp the tab order.
            tabIndex={-1}
            aria-label={`${segment.label}, message ${segment.messageNumber}`}
            className={clsx(
              styles.item,
              segment.startsMessage && styles.messageStart,
              hover?.index === index && styles.hovered
            )}
            style={segment.style}
            onMouseEnter={(e) => show(index, e)}
            onClick={() => onSelect(segment.location)}
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
            <Swatch fill={hovered.style} />
            <span className={styles.tooltipTitle}>{hovered.label}</span>
            <span className={styles.tooltipMessage}>
              message {hovered.messageNumber}
            </span>
          </div>
          <div className={styles.tooltipText}>
            {JSON.stringify(hovered.text)}
          </div>
          {hovered.count > 1 ? (
            <div className={styles.tooltipDetail}>
              {spanCountLabel(hovered.count, unit)} in this segment
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
