import clsx from "clsx";
import { FC, Fragment, useState } from "react";

import { PopOver } from "@tsmono/react/components";

import { RenderedText } from "../../content/RenderedText";

import styles from "./LabelledReasoning.module.css";
import {
  isDimmed,
  isYesNoQuestion,
  labelText,
  optionMark,
  spanKey,
} from "./spanLabels";
import type {
  LabelledSpan,
  SpanLabelQuestion,
  TextSegment,
} from "./spanLabels";
import { useSpanLabels, type SpanLabelsView } from "./SpanLabelsContext";
import { Swatch } from "./Swatch";

interface LabelledReasoningProps {
  segments: readonly TextSegment[];
}

/**
 * Reasoning text rendered as its labelled paragraphs. Each paragraph is a
 * separate markdown block, so a code fence that spans a blank line renders
 * as two broken halves.
 */
export const LabelledReasoning: FC<LabelledReasoningProps> = ({ segments }) => {
  const view = useSpanLabels();
  if (!view) {
    return <RenderedText markdown={segments.map((s) => s.text).join("")} />;
  }
  return (
    <div className={styles.paragraphs}>
      {segments.map((segment, index) =>
        segment.span ? (
          <LabelledParagraph
            key={`${index}-${segment.span.start}`}
            text={segment.text}
            span={segment.span}
            view={view}
          />
        ) : (
          <div
            key={`${index}-gap`}
            className={clsx(
              styles.unlabelled,
              isDimmed(view.highlighted, view.colorBy, undefined) &&
                styles.dimmed
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
  span: LabelledSpan;
  view: SpanLabelsView;
}

const LabelledParagraph: FC<LabelledParagraphProps> = ({
  text,
  span,
  view,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [paragraphEl, setParagraphEl] = useState<HTMLDivElement | null>(null);
  const key = spanKey(span);
  const popoverId = `span-label-${key}`;
  const flash = view.flash?.key === key ? view.flash : undefined;
  const mark = optionMark(view.colorBy, span.labels[view.colorBy.name]);

  return (
    <Fragment>
      <div
        ref={setParagraphEl}
        data-span-key={key}
        className={clsx(
          styles.paragraph,
          isDimmed(view.highlighted, view.colorBy, span) && styles.dimmed
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
        <LabelChips span={span} view={view} />
        <RenderedText markdown={text} className={styles.markdown} />
        {flash ? (
          // Keyed by the request so a repeat click replays the animation.
          <span key={flash.nonce} className={styles.flash} aria-hidden />
        ) : null}
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
        <SpanProbabilities span={span} questions={view.labels.questions} />
      </PopOver>
    </Fragment>
  );
};

const LabelChips: FC<{ span: LabelledSpan; view: SpanLabelsView }> = ({
  span,
  view,
}) => {
  const colorLabel = span.labels[view.colorBy.name];
  const others = view.labels.questions.filter((q) => q !== view.colorBy);
  return (
    <div className={styles.chips}>
      {colorLabel !== undefined ? (
        <span className={clsx(styles.chip, styles.primaryChip)}>
          <Swatch mark={optionMark(view.colorBy, colorLabel)} />
          {labelText(view.colorBy, colorLabel)}
        </span>
      ) : null}
      {others.map((question) => {
        const label = span.labels[question.name];
        if (label === undefined) return null;
        if (isYesNoQuestion(question)) {
          return label === "yes" ? (
            <span
              key={question.name}
              className={clsx(styles.chip, styles.flagChip)}
            >
              {question.name}
            </span>
          ) : null;
        }
        return (
          <span
            key={question.name}
            className={clsx(styles.chip, styles.mutedChip)}
            title={question.name}
          >
            {labelText(question, label)}
          </span>
        );
      })}
    </div>
  );
};

const SpanProbabilities: FC<{
  span: LabelledSpan;
  questions: readonly SpanLabelQuestion[];
}> = ({ span, questions }) => (
  <div className={styles.probabilities}>
    {questions.map((question) => {
      const label = span.labels[question.name];
      const distribution = span.probabilities[question.name] ?? {};
      const rows = Object.entries(distribution).sort((a, b) => b[1] - a[1]);
      return (
        <div key={question.name}>
          <div className={styles.questionHeader}>
            <span
              className={styles.questionName}
              title={question.description ?? undefined}
            >
              {question.name}
            </span>
            <span className={styles.questionLabel}>{label ?? "—"}</span>
          </div>
          {rows.map(([option, probability]) => (
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
