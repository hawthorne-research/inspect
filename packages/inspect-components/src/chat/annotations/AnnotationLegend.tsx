import clsx from "clsx";
import { FC } from "react";

import { SegmentedControl } from "@tsmono/react/components";

import styles from "./AnnotationLegend.module.css";
import {
  countOptions,
  fieldDetails,
  fieldTitle,
  formatValue,
  metadataEntries,
  optionStyle,
  paletteColors,
  segmentOf,
  spanCountLabel,
  spanNoun,
  withAlpha,
  type AnnotationField,
  type AnnotationView,
  type CategoricalField,
  type Palette,
  type ResolvedSet,
  type SpanLocation,
  type StripSegment,
} from "./model";
import { OverviewStrip } from "./OverviewStrip";
import { SpanTooltip } from "./SpanTooltip";
import { Swatch } from "./Swatch";
import { useHoveredSpan } from "./useHoveredSpan";

// A few short field names fit a segmented control; more fields, or long
// names, go in a select.
const kMaxSegmentedFields = 4;
const kMaxSegmentedLabel = 20;

interface AnnotationLegendProps {
  view: AnnotationView;
  /** Every annotation set of the sample, for the picker. */
  sets: readonly ResolvedSet[];
  strip: readonly StripSegment[];
  onSetChange: (id: string) => void;
  onFieldChange: (name: string) => void;
  onToggleHighlight: (option: string) => void;
  onClearHighlight: () => void;
  onSelectSpan: (location: SpanLocation) => void;
  /** Moves to the next colour scheme (`step` 1) or the previous (-1). */
  onCycleScheme: (step: 1 | -1) => void;
}

/**
 * The active annotation set's summary, set and field pickers, the field's key
 * and its overview strip. Also hosts the shared tooltip of annotated
 * spans.
 */
export const AnnotationLegend: FC<AnnotationLegendProps> = ({
  view,
  sets,
  strip,
  onSetChange,
  onFieldChange,
  onToggleHighlight,
  onClearHighlight,
  onSelectSpan,
  onCycleScheme,
}) => {
  const { set, field } = view;
  const hover = useHoveredSpan(set);
  return (
    // Find skips the legend: its names would shadow the transcript.
    <section
      className={styles.legend}
      aria-label="Text annotations"
      data-unsearchable
    >
      <div className={styles.header}>
        {sets.length > 1 ? (
          <SetPicker sets={sets} selected={set} onChange={onSetChange} />
        ) : (
          <span
            className="text-style-label text-style-secondary"
            title={set.description ?? undefined}
          >
            {set.name}
          </span>
        )}
        <span className={styles.source}>
          {[
            set.source,
            ...metadataEntries(set.metadata),
            spanCountLabel(set.spanCount, set.unit),
          ]
            .filter((s) => s !== "")
            .join(" · ")}
        </span>
        <FieldPicker
          fields={set.fields}
          selected={field}
          onChange={onFieldChange}
        />
        <SchemeButton palette={view.palette} onCycle={onCycleScheme} />
      </div>
      {field.type === "categorical" ? (
        <OptionKey
          set={set}
          field={field}
          highlighted={view.highlighted}
          palette={view.palette}
          onToggle={onToggleHighlight}
          onClear={onClearHighlight}
        />
      ) : (
        <ColorBar scale={view.scale} palette={view.palette} />
      )}
      <OverviewStrip
        segments={strip}
        marked={
          hover
            ? segmentOf(strip, set, {
                part: hover.part.index,
                span: hover.span,
              })
            : undefined
        }
        unit={set.unit}
        onSelect={onSelectSpan}
      />
      <SpanTooltip view={view} hover={hover} />
    </section>
  );
};

const SetPicker: FC<{
  sets: readonly ResolvedSet[];
  selected: ResolvedSet;
  onChange: (id: string) => void;
}> = ({ sets, selected, onChange }) => (
  <select
    aria-label="Annotation set"
    className={clsx(styles.select, styles.setSelect)}
    value={selected.id}
    title={selected.description ?? undefined}
    onChange={(e) => onChange(e.target.value)}
  >
    {sets.map((set) => (
      <option key={set.id} value={set.id} title={set.description ?? undefined}>
        {setLabel(set, sets)}
      </option>
    ))}
  </select>
);

/** An annotation set's name and `spanNoun`, with its score when another
 *  score has a set of the same name. */
const setLabel = (set: ResolvedSet, sets: readonly ResolvedSet[]): string => {
  const label = `${set.name} · ${spanNoun(set.unit)}`;
  const ambiguous = sets.some(
    (other) => other !== set && other.name === set.name
  );
  return ambiguous ? `${label} (${set.score})` : label;
};

const FieldPicker: FC<{
  fields: readonly AnnotationField[];
  selected: AnnotationField;
  onChange: (name: string) => void;
}> = ({ fields, selected, onChange }) => (
  <span className={styles.fieldPicker} title={detailedTitle(selected)}>
    <span className="text-style-secondary">Color by</span>
    {fields.length <= kMaxSegmentedFields &&
    fields.every((f) => f.name.length <= kMaxSegmentedLabel) ? (
      <SegmentedControl
        segments={fields.map((f) => ({ id: f.name, label: f.name }))}
        selectedId={selected.name}
        onSegmentChange={onChange}
      />
    ) : (
      <select
        aria-label="Color by"
        className={styles.select}
        value={selected.name}
        onChange={(e) => onChange(e.target.value)}
      >
        {fields.map((f) => (
          <option key={f.name} value={f.name} title={detailedTitle(f)}>
            {f.name}
          </option>
        ))}
      </select>
    )}
  </span>
);

/** The field's title when it has more to show than its name. */
const detailedTitle = (field: AnnotationField): string | undefined =>
  fieldDetails(field).length > 0 ? fieldTitle(field) : undefined;

/** Each option's tint (none for a negative option) and count; clicking
 *  options highlights their spans. */
const OptionKey: FC<{
  set: ResolvedSet;
  field: CategoricalField;
  highlighted: readonly string[];
  palette: Palette;
  onToggle: (option: string) => void;
  onClear: () => void;
}> = ({ set, field, highlighted, palette, onToggle, onClear }) => (
  <div className={styles.options} role="group" aria-label="Options">
    {countOptions(set, field).map(({ option, count }) => {
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
          onClick={() => onToggle(option)}
        >
          <Swatch fill={optionStyle(field, option, [], palette)} />
          {option}
          <span className={styles.count}>{count.toLocaleString()}</span>
        </button>
      );
    })}
    {highlighted.length > 0 ? (
      <button type="button" className={styles.clear} onClick={onClear}>
        Show all
      </button>
    ) : null}
  </div>
);

const ColorBar: FC<{ scale: number; palette: Palette }> = ({
  scale,
  palette,
}) => {
  if (scale <= 0) {
    return <span className={styles.noScale}>all values are 0</span>;
  }
  const { negative, positive } = paletteColors(palette);
  const full = palette.scheme.maxShade;
  return (
    <span
      className={styles.colorBar}
      title={`Values at or beyond ±${formatValue(scale)} (the 99th percentile of |value| for this field) get full colour`}
    >
      <span
        className={styles.gradient}
        style={{
          backgroundImage: `linear-gradient(to right, ${withAlpha(negative, full)}, transparent 50%, ${withAlpha(positive, full)})`,
        }}
      />
      <span className={styles.ticks}>
        <span>{formatValue(-scale)}</span>
        <span>0</span>
        <span>{formatValue(scale)}</span>
      </span>
    </span>
  );
};

/** Shows the colour scheme's first hues and name; a click moves to the
 *  next scheme, a shift-click to the previous one. */
const SchemeButton: FC<{
  palette: Palette;
  onCycle: (step: 1 | -1) => void;
}> = ({ palette, onCycle }) => (
  <button
    type="button"
    className={styles.schemeButton}
    title={`Colour scheme: ${palette.scheme.name}. Click for the next scheme, shift-click for the previous one.`}
    aria-label={`Colour scheme: ${palette.scheme.name}. Next colour scheme`}
    onClick={(e) => onCycle(e.shiftKey ? -1 : 1)}
  >
    <span className={styles.schemeSwatches} aria-hidden>
      {paletteColors(palette)
        .options.slice(0, 4)
        .map((color) => (
          <span
            key={color}
            className={styles.schemeSwatch}
            style={{
              backgroundColor: withAlpha(
                color,
                Math.max(palette.scheme.tint, 0.6)
              ),
            }}
          />
        ))}
    </span>
    {palette.scheme.name}
  </button>
);
