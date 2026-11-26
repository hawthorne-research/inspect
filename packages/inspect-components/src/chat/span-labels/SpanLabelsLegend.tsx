import clsx from "clsx";
import { FC } from "react";

import { SegmentedControl } from "@tsmono/react/components";

import { countLabels, optionMark } from "./spanLabels";
import type { SpanLabelsView } from "./SpanLabelsContext";
import styles from "./SpanLabelsLegend.module.css";
import { SpanStrip } from "./SpanStrip";
import type { StripSegment } from "./stripSegments";
import { Swatch } from "./Swatch";

interface SpanLabelsLegendProps {
  view: SpanLabelsView;
  segments: readonly StripSegment[];
  onColorByChange: (question: string) => void;
  onToggleHighlight: (option: string) => void;
  onClearHighlight: () => void;
  onSelectSegment: (segment: StripSegment) => void;
}

/** Classifier summary, color-by picker, per-option counts and the
 *  composition strip for a labelled sample. Clicking an option toggles it as
 *  a highlight; paragraphs and segments with other labels are dimmed. */
export const SpanLabelsLegend: FC<SpanLabelsLegendProps> = ({
  view,
  segments,
  onColorByChange,
  onToggleHighlight,
  onClearHighlight,
  onSelectSegment,
}) => {
  const { labels, colorBy, highlighted } = view;
  const counts = countLabels(labels, colorBy);

  return (
    // Find skips the legend: its option names would shadow the paragraphs.
    <section
      className={styles.legend}
      aria-label="Paragraph labels"
      data-unsearchable
    >
      <div className={styles.header}>
        <span className="text-style-label text-style-secondary">
          Paragraph labels
        </span>
        <span className={styles.source}>
          {labels.classifier} · {labels.spans.length} {labels.unit}s
        </span>
        <span
          className={styles.colorBy}
          title={
            colorBy.description
              ? `${colorBy.name}: ${colorBy.description}`
              : undefined
          }
        >
          <span className="text-style-secondary">Color by</span>
          <SegmentedControl
            segments={labels.questions.map((q) => ({
              id: q.name,
              label: q.name,
            }))}
            selectedId={colorBy.name}
            onSegmentChange={onColorByChange}
          />
        </span>
      </div>
      <div className={styles.options}>
        {counts.map(({ option, count }) => {
          const active = highlighted.includes(option);
          return (
            <button
              key={option}
              type="button"
              aria-pressed={active}
              className={clsx(
                styles.option,
                active && styles.active,
                highlighted.length > 0 && !active && styles.inactive
              )}
              onClick={() => onToggleHighlight(option)}
            >
              <Swatch mark={optionMark(colorBy, option)} />
              {option}
              <span className={styles.count}>{count}</span>
            </button>
          );
        })}
        {highlighted.length > 0 ? (
          <button
            type="button"
            className={styles.clear}
            onClick={onClearHighlight}
          >
            Show all
          </button>
        ) : null}
      </div>
      <SpanStrip segments={segments} view={view} onSelect={onSelectSegment} />
    </section>
  );
};
