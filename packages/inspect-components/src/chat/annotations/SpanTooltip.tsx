import clsx from "clsx";
import { FC, useState } from "react";

import { useEventListener } from "@tsmono/react/hooks";

import { hoveredSpan, type HoveredSpan } from "./dom";
import { fieldLabel } from "./format";
import { spanText } from "./layers";
import styles from "./SpanTooltip.module.css";
import { Swatch } from "./Swatch";
import { spanStyle, spanValue, type AnnotationView } from "./view";

const kWidth = 340;
const kColumnWidth = 220;
const kGap = 6;
// Longer field lists wrap into more columns rather than a tall tooltip.
const kRowsPerColumn = 12;

/**
 * The one tooltip for every annotated span in the Messages tab: the span's
 * text and its value of each field of the layer. Listens for hover on the
 * document rather than on each of the sample's spans, and hides on scroll,
 * which would leave it behind.
 */
export const SpanTooltip: FC<{ view: AnnotationView }> = ({ view }) => {
  const [hover, setHover] = useState<HoveredSpan | null>(null);
  useEventListener(document, "mouseover", (e) => {
    setHover(hoveredSpan(e, view.layer));
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

  const { part, span, rect } = hover;
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
      <div
        className={styles.fields}
        style={{
          gridTemplateRows: `repeat(${Math.ceil(fields.length / columns)}, auto)`,
        }}
      >
        {fields.map((field) => {
          const active = field.name === view.field.name;
          const value = spanValue(field, part, span);
          return (
            <div
              key={field.name}
              className={clsx(styles.field, active && styles.active)}
            >
              <div className={styles.row}>
                {active ? <Swatch fill={spanStyle(view, part, span)} /> : null}
                <span className={styles.name}>{fieldLabel(field)}</span>
                <span className={styles.value}>{value.text}</span>
              </div>
              {value.probabilities.length > 0 ? (
                <div className={styles.probabilities}>
                  {value.probabilities.map(
                    ({ option, probability, chosen }) => (
                      <span
                        key={option}
                        className={clsx(chosen && styles.chosen)}
                      >
                        {option}{" "}
                        <span className={styles.percent}>
                          {formatProbability(probability)}
                        </span>
                      </span>
                    )
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
};

const formatProbability = (p: number): string =>
  p > 0 && p < 0.01 ? "<1%" : `${Math.round(p * 100)}%`;
