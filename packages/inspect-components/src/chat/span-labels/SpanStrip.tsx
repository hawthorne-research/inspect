import clsx from "clsx";
import { CSSProperties, FC, MouseEvent, useState } from "react";

import { isDimmed, labelText, optionMark, type OptionMark } from "./spanLabels";
import type { SpanLabelsView } from "./SpanLabelsContext";
import styles from "./SpanStrip.module.css";
import type { StripSegment } from "./stripSegments";
import { Swatch } from "./Swatch";

const kTooltipWidth = 320;

interface SpanStripProps {
  segments: readonly StripSegment[];
  view: SpanLabelsView;
  onSelect: (segment: StripSegment) => void;
}

/**
 * One equal-width segment per labelled paragraph, in transcript order,
 * coloured like the paragraphs. Hovering shows the paragraph's label and
 * opening; clicking asks the host to scroll to it.
 */
export const SpanStrip: FC<SpanStripProps> = ({ segments, view, onSelect }) => {
  const [hover, setHover] = useState<{ index: number; left: number } | null>(
    null
  );
  const hovered = hover ? segments[hover.index] : undefined;

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
        className={styles.segments}
        role="group"
        aria-label="Labelled paragraphs in transcript order"
      >
        {segments.map((segment, index) => {
          const label = segment.span.labels[view.colorBy.name];
          return (
            <button
              key={segment.key}
              type="button"
              // Hundreds of segments would swamp the tab order.
              tabIndex={-1}
              aria-label={`${label ?? "unlabelled"}, message ${segment.messageNumber}: ${segment.preview}`}
              className={clsx(
                styles.segment,
                segment.startsMessage && index > 0 && styles.messageStart,
                isDimmed(view.highlighted, view.colorBy, segment.span) &&
                  styles.dimmed,
                hover?.index === index && styles.hovered
              )}
              style={segmentStyle(optionMark(view.colorBy, label))}
              onMouseEnter={(e) => showTooltip(index, e)}
              onClick={() => onSelect(segment)}
            />
          );
        })}
      </div>
      {hover && hovered ? (
        <div
          className={styles.tooltip}
          style={{ left: hover.left, width: kTooltipWidth }}
          role="tooltip"
        >
          <div className={styles.tooltipHeader}>
            <Swatch
              mark={optionMark(
                view.colorBy,
                hovered.span.labels[view.colorBy.name]
              )}
            />
            <span className={styles.tooltipLabel}>
              {labelLine(view, hovered)}
            </span>
            <span className={styles.tooltipMessage}>
              message {hovered.messageNumber}
            </span>
          </div>
          <div className={styles.tooltipPreview}>{hovered.preview}</div>
        </div>
      ) : null}
    </div>
  );
};

const labelLine = (view: SpanLabelsView, segment: StripSegment): string => {
  const label = segment.span.labels[view.colorBy.name];
  return label === undefined ? "unlabelled" : labelText(view.colorBy, label);
};

/** Hollow marks are hatched: at 2–3px wide a dashed border can't show. */
const segmentStyle = (mark: OptionMark): CSSProperties =>
  mark.hollow
    ? {
        backgroundImage: `repeating-linear-gradient(135deg, ${mark.color} 0 2px, transparent 2px 4px)`,
        boxShadow: `inset 0 0 0 1px ${mark.color}`,
      }
    : { backgroundColor: mark.color };
