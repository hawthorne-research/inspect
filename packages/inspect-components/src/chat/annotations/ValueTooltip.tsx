import clsx from "clsx";
import { FC, useState } from "react";

import { useEventListener } from "@tsmono/react/hooks";

import type { AnnotationView } from "./context";
import { hoveredSpan, type HoveredSpan } from "./dom";
import { fieldLabel } from "./format";
import { spanText } from "./layers";
import { formatValue, valueStyle } from "./numeric";
import { Swatch } from "./Swatch";
import styles from "./ValueTooltip.module.css";

const kWidth = 320;
const kColumnWidth = 180;
const kGap = 6;
// Longer field lists wrap into more columns rather than a tall tooltip.
const kRowsPerColumn = 12;

/**
 * The one tooltip for every shaded span in the Messages tab: listens for
 * hover on the document rather than on each of the sample's spans, and
 * hides on scroll, which would leave it behind.
 */
export const ValueTooltip: FC<{ view: AnnotationView }> = ({ view }) => {
  const [hover, setHover] = useState<HoveredSpan | null>(null);
  useEventListener(document, "mouseover", (e) => {
    setHover(hoveredSpan(e.target, view.layer));
  });
  // No mouseover follows when the pointer leaves the window.
  useEventListener(document, "mouseout", (e) => {
    if (!e.relatedTarget) setHover(null);
  });
  useEventListener(document, "scroll", () => setHover(null), {
    capture: true,
    passive: true,
  });
  if (!hover || view.field.type !== "numeric") return null;

  const { part, span, rect } = hover;
  const field = view.field;
  const value = part.values.get(field.name)?.[span] ?? 0;
  const fields = view.layer.fields;
  const columns = Math.ceil(fields.length / kRowsPerColumn);
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
      <div className={styles.text}>{JSON.stringify(spanText(part, span))}</div>
      <div className={styles.selected}>
        <Swatch fill={valueStyle(value, view.scale)} />
        <span className={styles.name}>{fieldLabel(field)}</span>
        <span className={styles.value}>{formatValue(value)}</span>
      </div>
      {fields.length > 1 ? (
        <div
          className={styles.table}
          style={{
            gridTemplateRows: `repeat(${Math.ceil(fields.length / columns)}, auto)`,
          }}
        >
          {fields.map((other) => {
            const otherValue =
              other.type === "numeric"
                ? formatValue(part.values.get(other.name)?.[span] ?? 0)
                : (part.labels.get(other.name)?.[span] ?? "—");
            return (
              <div
                key={other.name}
                className={clsx(styles.row, other === field && styles.current)}
              >
                <span className={styles.name}>{fieldLabel(other)}</span>
                <span className={styles.value}>{otherValue}</span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
};
