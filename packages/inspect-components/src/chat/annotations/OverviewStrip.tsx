import clsx from "clsx";
import { CSSProperties, FC, MouseEvent, ReactNode, useState } from "react";

import {
  isDimmed,
  labelText,
  optionMark,
  type OptionMark,
} from "./categorical";
import type { CategoricalField } from "./format";
import { formatValue, valueStyle } from "./numeric";
import styles from "./OverviewStrip.module.css";
import type { LabelSegment, PeakBin, SpanLocation } from "./strip";
import { Swatch } from "./Swatch";

interface Hover {
  index: number;
  left: number;
}

/** Hover state for a strip's items, with the tooltip's left offset kept
 *  inside the strip. */
const useStripHover = (tooltipWidth: number) => {
  const [hover, setHover] = useState<Hover | null>(null);
  const show = (index: number, e: MouseEvent<HTMLButtonElement>) => {
    const target = e.currentTarget;
    const stripWidth =
      target.offsetParent instanceof HTMLElement
        ? target.offsetParent.clientWidth
        : 0;
    const center = target.offsetLeft + target.offsetWidth / 2;
    const left = Math.max(
      0,
      Math.min(center - tooltipWidth / 2, stripWidth - tooltipWidth)
    );
    setHover({ index, left });
  };
  return { hover, show, clear: () => setHover(null) };
};

const StripTooltip: FC<{
  left: number;
  width: number;
  children: ReactNode;
}> = ({ left, width, children }) => (
  <div className={styles.tooltip} style={{ left, width }} role="tooltip">
    {children}
  </div>
);

const kLabelTooltipWidth = 320;

interface LabelStripProps {
  segments: readonly LabelSegment[];
  field: CategoricalField;
  highlighted: readonly string[];
  onSelect: (location: SpanLocation) => void;
}

/**
 * One equal-width segment per span, in transcript order, coloured like the
 * spans. Hovering shows the span's label and opening; clicking asks the
 * host to scroll to it.
 */
export const LabelStrip: FC<LabelStripProps> = ({
  segments,
  field,
  highlighted,
  onSelect,
}) => {
  const { hover, show, clear } = useStripHover(kLabelTooltipWidth);
  const hovered = hover ? segments[hover.index] : undefined;
  return (
    <div className={styles.strip} onMouseLeave={clear}>
      <div
        className={styles.items}
        role="group"
        aria-label="Labelled spans in transcript order"
      >
        {segments.map((segment, index) => (
          <button
            key={`${segment.location.part}-${segment.location.span}`}
            type="button"
            // Hundreds of segments would swamp the tab order.
            tabIndex={-1}
            aria-label={`${segment.label ?? "unlabelled"}, message ${segment.messageNumber}: ${segment.preview}`}
            className={clsx(
              styles.item,
              segment.startsMessage && index > 0 && styles.messageStart,
              isDimmed(highlighted, segment.label) && styles.dimmed,
              hover?.index === index && styles.hovered
            )}
            style={segmentStyle(optionMark(field, segment.label))}
            onMouseEnter={(e) => show(index, e)}
            onClick={() => onSelect(segment.location)}
          />
        ))}
      </div>
      {hover && hovered ? (
        <StripTooltip left={hover.left} width={kLabelTooltipWidth}>
          <div className={styles.tooltipHeader}>
            <Swatch mark={optionMark(field, hovered.label)} />
            <span className={styles.tooltipTitle}>
              {hovered.label === undefined
                ? "unlabelled"
                : labelText(field, hovered.label)}
            </span>
            <span className={styles.tooltipMessage}>
              message {hovered.messageNumber}
            </span>
          </div>
          <div className={styles.tooltipDetail}>{hovered.preview}</div>
        </StripTooltip>
      ) : null}
    </div>
  );
};

/** Hollow marks are hatched: at 2–3px wide a dashed border can't show. */
const segmentStyle = (mark: OptionMark): CSSProperties =>
  mark.hollow
    ? {
        backgroundImage: `repeating-linear-gradient(135deg, ${mark.color} 0 2px, transparent 2px 4px)`,
        boxShadow: `inset 0 0 0 1px ${mark.color}`,
      }
    : { backgroundColor: mark.color };

const kPeakTooltipWidth = 280;

interface PeakStripProps {
  bins: readonly PeakBin[];
  scale: number;
  /** What one span is, e.g. "token". */
  unit: string;
  onSelect: (location: SpanLocation) => void;
}

/**
 * Every span in transcript order, binned and coloured by each bin's peak.
 * Hovering shows the peak; clicking asks the host to scroll to its span.
 */
export const PeakStrip: FC<PeakStripProps> = ({
  bins,
  scale,
  unit,
  onSelect,
}) => {
  const { hover, show, clear } = useStripHover(kPeakTooltipWidth);
  const hovered = hover ? bins[hover.index] : undefined;
  return (
    <div className={styles.strip} onMouseLeave={clear}>
      <div
        className={clsx(styles.items, styles.binned)}
        role="group"
        aria-label="Values in transcript order"
      >
        {bins.map((bin, index) => (
          <button
            key={index}
            type="button"
            tabIndex={-1}
            aria-label={`Peak ${formatValue(bin.peak)}, message ${bin.messageNumber}`}
            className={clsx(
              styles.item,
              styles.bin,
              hover?.index === index && styles.hovered
            )}
            style={valueStyle(bin.peak, scale)}
            onMouseEnter={(e) => show(index, e)}
            onClick={() => onSelect(bin.location)}
          />
        ))}
      </div>
      {hover && hovered ? (
        <StripTooltip left={hover.left} width={kPeakTooltipWidth}>
          <div className={styles.tooltipHeader}>
            <Swatch fill={valueStyle(hovered.peak, scale)} />
            <span className={clsx(styles.tooltipTitle, styles.numeric)}>
              peak {formatValue(hovered.peak)}
            </span>
            <span className={styles.tooltipMessage}>
              message {hovered.messageNumber}
            </span>
          </div>
          <div className={styles.tooltipText}>
            {JSON.stringify(hovered.text)}
          </div>
          <div className={styles.tooltipDetail}>
            {hovered.count} {hovered.count === 1 ? unit : `${unit}s`} in bin
          </div>
        </StripTooltip>
      ) : null}
    </div>
  );
};
