import clsx from "clsx";
import { FC, useState } from "react";

import { useEventListener } from "@tsmono/react/hooks";

import { hoveredSpan, type HoveredSpan } from "./dom";
import {
  fieldScale,
  fieldTitle,
  paletteColors,
  spanStyle,
  spanText,
  spanValue,
  valueIntensity,
  type AnnotationField,
  type AnnotationView,
  type Palette,
  type ResolvedLayer,
  type ResolvedPart,
  type SpanStyle,
} from "./model";
import styles from "./SpanTooltip.module.css";
import { Swatch } from "./Swatch";

const kColumnWidth = 430;
const kGap = 6;
// More rows than this flow into another column rather than a tall tooltip.
const kRowsPerColumn = 18;
const kMaxColumns = 3;

/**
 * The one tooltip for every annotated span in the Messages tab: the span's
 * text, then the span's value of each field of the layer, each with a bar
 * (an option's probability, or a value against the field's colour scale).
 * Listens for hover on the document rather than on each of the sample's
 * spans, and hides on scroll, which would leave it behind.
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
  const rows = fields.reduce(
    (sum, field) => sum + 1 + spanValue(field, part, span).probabilities.length,
    0
  );
  const columns = Math.min(kMaxColumns, Math.ceil(rows / kRowsPerColumn));
  const width = Math.min(window.innerWidth - 2 * kGap, columns * kColumnWidth);
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
        width,
        ...(below
          ? { top: rect.bottom + kGap }
          : { bottom: window.innerHeight - rect.top + kGap }),
      }}
    >
      <div className={styles.text}>{JSON.stringify(spanText(part, span))}</div>
      <div className={styles.fields} style={{ columnCount: columns }}>
        {fields.map((field) => (
          <FieldValue
            key={field.name}
            field={field}
            layer={view.layer}
            palette={view.palette}
            part={part}
            span={span}
            swatch={
              field.name === view.field.name
                ? spanStyle(view, part, span)
                : null
            }
          />
        ))}
      </div>
    </div>
  );
};

/** One field's value on the span: a numeric field is one row with a bar
 *  from zero; a categorical one is its label, then each option's
 *  probability when the layer has them. `swatch` marks the field that
 *  colours the spans (null for the others). */
const FieldValue: FC<{
  field: AnnotationField;
  layer: ResolvedLayer;
  palette: Palette;
  part: ResolvedPart;
  span: number;
  swatch: SpanStyle | undefined | null;
}> = ({ field, layer, palette, part, span, swatch }) => {
  const value = spanValue(field, part, span);
  const active = swatch !== null;
  const name = (
    <span className={styles.fieldName} title={fieldTitle(field)}>
      {active ? <Swatch fill={swatch} /> : null}
      {field.name}
    </span>
  );

  if (field.type === "numeric") {
    const intensity =
      value.number === undefined
        ? 0
        : valueIntensity(value.number, fieldScale(layer, field));
    return (
      <div className={clsx(styles.row, active && styles.active)}>
        {name}
        <DivergingBar intensity={intensity} palette={palette} />
        <span className={styles.number}>{value.text}</span>
      </div>
    );
  }

  return (
    <div className={clsx(styles.field, active && styles.active)}>
      <div className={styles.header}>
        {name}
        <span className={styles.label}>{value.text}</span>
      </div>
      {value.probabilities.map(({ option, probability, chosen }) => (
        <div
          key={option}
          className={clsx(styles.row, styles.option, chosen && styles.chosen)}
        >
          <span className={styles.optionName} title={option}>
            {option}
          </span>
          <span className={styles.bar}>
            <span
              className={styles.barFill}
              style={{ width: `${probability * 100}%` }}
            />
          </span>
          <span className={styles.number}>
            {formatProbability(probability)}
          </span>
        </div>
      ))}
    </div>
  );
};

/** A bar centred on zero, filled towards the value's sign by `intensity`
 *  (its share of full colour, in [-1, 1]) in the same hue as the text. */
const DivergingBar: FC<{ intensity: number; palette: Palette }> = ({
  intensity,
  palette,
}) => {
  const { negative, positive } = paletteColors(palette);
  return (
    <span className={clsx(styles.bar, styles.diverging)}>
      {intensity !== 0 ? (
        <span
          className={clsx(
            styles.divergingFill,
            intensity > 0 ? styles.positive : styles.negative
          )}
          style={{
            width: `${Math.abs(intensity) * 50}%`,
            backgroundColor: intensity > 0 ? positive : negative,
          }}
        />
      ) : null}
    </span>
  );
};

const formatProbability = (p: number): string =>
  p > 0 && p < 0.01 ? "<1%" : `${Math.round(p * 100)}%`;
