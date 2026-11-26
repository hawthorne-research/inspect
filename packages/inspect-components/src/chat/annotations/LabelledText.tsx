import clsx from "clsx";
import { FC, Fragment, useState } from "react";

import { PopOver } from "@tsmono/react/components";

import { RenderedText } from "../../content";

import { isDimmed, isYesNoField, labelText, optionMark } from "./categorical";
import type { AnnotationView } from "./context";
import { kPartAttribute, kSpanAttribute } from "./dom";
import { fieldLabel, type CategoricalField } from "./format";
import styles from "./LabelledText.module.css";
import { textSegments, type ResolvedPart } from "./layers";
import { formatValue } from "./numeric";
import { Swatch } from "./Swatch";

interface LabelledTextProps {
  part: ResolvedPart;
  view: AnnotationView;
  field: CategoricalField;
}

/**
 * A content part rendered as its labelled spans, each a markdown block
 * with a border coloured by its label in `field`, chips and a hover
 * popover. A code fence that spans a blank line between two spans renders
 * as two broken halves.
 */
export const LabelledText: FC<LabelledTextProps> = ({ part, view, field }) => {
  const labels = part.labels.get(field.name) ?? [];
  return (
    <div {...{ [kPartAttribute]: part.index }} className={styles.paragraphs}>
      {textSegments(part).map((segment, index) =>
        segment.span !== undefined ? (
          <LabelledParagraph
            key={`${index}-span`}
            text={segment.text}
            part={part}
            span={segment.span}
            view={view}
            field={field}
            label={labels[segment.span]}
          />
        ) : (
          <div
            key={`${index}-gap`}
            className={clsx(
              styles.unlabelled,
              isDimmed(view.highlighted, undefined) && styles.dimmed
            )}
          >
            <RenderedText markdown={segment.text} className={styles.markdown} />
          </div>
        )
      )}
    </div>
  );
};

interface LabelledParagraphProps {
  text: string;
  part: ResolvedPart;
  span: number;
  view: AnnotationView;
  field: CategoricalField;
  label: string | undefined;
}

const LabelledParagraph: FC<LabelledParagraphProps> = ({
  text,
  part,
  span,
  view,
  field,
  label,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [paragraphEl, setParagraphEl] = useState<HTMLDivElement | null>(null);
  const popoverId = `annotation-span-${part.index}-${span}`;
  const mark = optionMark(field, label);

  return (
    <Fragment>
      <div
        ref={setParagraphEl}
        {...{ [kSpanAttribute]: span }}
        className={clsx(
          styles.paragraph,
          isDimmed(view.highlighted, label) && styles.dimmed
        )}
        style={{
          borderLeftColor: mark.color,
          borderLeftStyle: mark.hollow ? "dashed" : "solid",
        }}
        onMouseEnter={() => setIsOpen(true)}
        onMouseLeave={() => {
          // A fast swipe can leave before PopOver attaches its own
          // mouseleave listener; cancel an open that hasn't shown yet.
          if (!document.getElementById(popoverId)) setIsOpen(false);
        }}
      >
        <LabelChips part={part} span={span} view={view} field={field} />
        <RenderedText markdown={text} className={styles.markdown} />
      </div>
      <PopOver
        id={popoverId}
        isOpen={isOpen}
        setIsOpen={setIsOpen}
        positionEl={paragraphEl}
        placement="bottom-end"
        showArrow={false}
        hoverDelay={500}
        className={styles.popover}
      >
        <SpanDetails part={part} span={span} view={view} />
      </PopOver>
    </Fragment>
  );
};

const LabelChips: FC<{
  part: ResolvedPart;
  span: number;
  view: AnnotationView;
  field: CategoricalField;
}> = ({ part, span, view, field }) => {
  const colorLabel = part.labels.get(field.name)?.[span];
  return (
    <div className={styles.chips}>
      {colorLabel !== undefined ? (
        <span className={clsx(styles.chip, styles.primaryChip)}>
          <Swatch mark={optionMark(field, colorLabel)} />
          {labelText(field, colorLabel)}
        </span>
      ) : null}
      {view.layer.fields.map((other) => {
        if (other === field || other.type !== "categorical") return null;
        const label = part.labels.get(other.name)?.[span];
        if (label === undefined) return null;
        if (isYesNoField(other)) {
          return label === "yes" ? (
            <span
              key={other.name}
              className={clsx(styles.chip, styles.flagChip)}
            >
              {other.name}
            </span>
          ) : null;
        }
        return (
          <span
            key={other.name}
            className={clsx(styles.chip, styles.mutedChip)}
            title={other.name}
          >
            {labelText(other, label)}
          </span>
        );
      })}
    </div>
  );
};

/** Every field's value for one span: categorical fields with their
 *  probability distribution when the layer has one. */
const SpanDetails: FC<{
  part: ResolvedPart;
  span: number;
  view: AnnotationView;
}> = ({ part, span, view }) => (
  <div className={styles.details}>
    {view.layer.fields.map((field) => {
      if (field.type === "numeric") {
        const value = part.values.get(field.name)?.[span];
        return (
          <div key={field.name} className={styles.fieldHeader}>
            <span
              className={styles.fieldName}
              title={field.description ?? undefined}
            >
              {fieldLabel(field)}
            </span>
            <span className={styles.fieldValue}>
              {value === undefined ? "—" : formatValue(value)}
            </span>
          </div>
        );
      }
      const label = part.labels.get(field.name)?.[span];
      const distribution = part.probabilities.get(field.name)?.[span] ?? [];
      const rows = distribution
        .map((probability, i) => ({
          option: field.options[i] ?? "",
          probability,
        }))
        .sort((a, b) => b.probability - a.probability);
      return (
        <div key={field.name}>
          <div className={styles.fieldHeader}>
            <span
              className={styles.fieldName}
              title={field.description ?? undefined}
            >
              {field.name}
            </span>
            <span className={styles.fieldValue}>{label ?? "—"}</span>
          </div>
          {rows.map(({ option, probability }) => (
            <div
              key={option}
              className={clsx(
                styles.optionRow,
                option === label && styles.chosenOption
              )}
            >
              <span className={styles.optionName}>{option}</span>
              <span className={styles.bar}>
                <span
                  className={styles.barFill}
                  style={{ width: `${probability * 100}%` }}
                />
              </span>
              <span className={styles.percent}>
                {formatProbability(probability)}
              </span>
            </div>
          ))}
        </div>
      );
    })}
  </div>
);

const formatProbability = (p: number): string =>
  p > 0 && p < 0.01 ? "<1%" : `${Math.round(p * 100)}%`;
