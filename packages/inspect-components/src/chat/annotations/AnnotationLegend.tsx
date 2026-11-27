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
  spanCountLabel,
  withAlpha,
  type AnnotationField,
  type AnnotationView,
  type CategoricalField,
  type Palette,
  type ResolvedLayer,
  type SpanLocation,
  type StripSegment,
} from "./model";
import { OverviewStrip } from "./OverviewStrip";
import { SpanTooltip } from "./SpanTooltip";
import { Swatch } from "./Swatch";

// A few short field names fit a segmented control; more fields, or long
// names, go in a select.
const kMaxSegmentedFields = 4;
const kMaxSegmentedLabel = 20;

interface AnnotationLegendProps {
  view: AnnotationView;
  /** Every layer of the sample, for the layer picker. */
  layers: readonly ResolvedLayer[];
  strip: readonly StripSegment[];
  onLayerChange: (id: string) => void;
  onFieldChange: (name: string) => void;
  onToggleHighlight: (option: string) => void;
  onClearHighlight: () => void;
  onSelectSpan: (location: SpanLocation) => void;
  /** Moves to the next colour scheme (`step` 1) or the previous (-1). */
  onCycleScheme: (step: 1 | -1) => void;
}

/**
 * The active layer's summary, layer and field pickers, the field's key
 * and its overview strip. Also hosts the shared tooltip of annotated
 * spans.
 */
export const AnnotationLegend: FC<AnnotationLegendProps> = ({
  view,
  layers,
  strip,
  onLayerChange,
  onFieldChange,
  onToggleHighlight,
  onClearHighlight,
  onSelectSpan,
  onCycleScheme,
}) => {
  const { layer, field } = view;
  return (
    // Find skips the legend: its names would shadow the transcript.
    <section
      className={styles.legend}
      aria-label="Text annotations"
      data-unsearchable
    >
      <div className={styles.header}>
        {layers.length > 1 ? (
          <LayerPicker
            layers={layers}
            selected={layer}
            onChange={onLayerChange}
          />
        ) : (
          <span
            className="text-style-label text-style-secondary"
            title={layer.description ?? undefined}
          >
            {layer.name}
          </span>
        )}
        <span className={styles.source}>
          {[
            layer.source,
            ...metadataEntries(layer.metadata),
            spanCountLabel(layer.spanCount, layer.unit),
          ]
            .filter((s) => s !== "")
            .join(" · ")}
        </span>
        <FieldPicker
          fields={layer.fields}
          selected={field}
          onChange={onFieldChange}
        />
        <SchemeButton palette={view.palette} onCycle={onCycleScheme} />
      </div>
      {field.type === "categorical" ? (
        <OptionKey
          layer={layer}
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
        unit={layer.unit}
        onSelect={onSelectSpan}
      />
      <SpanTooltip view={view} />
    </section>
  );
};

const LayerPicker: FC<{
  layers: readonly ResolvedLayer[];
  selected: ResolvedLayer;
  onChange: (id: string) => void;
}> = ({ layers, selected, onChange }) => (
  <select
    aria-label="Annotation layer"
    className={clsx(styles.select, styles.layerSelect)}
    value={selected.id}
    title={selected.description ?? undefined}
    onChange={(e) => onChange(e.target.value)}
  >
    {layers.map((layer) => (
      <option
        key={layer.id}
        value={layer.id}
        title={layer.description ?? undefined}
      >
        {layerLabel(layer, layers)}
      </option>
    ))}
  </select>
);

/** A layer's name and unit, with its score when another score has a layer
 *  of the same name. */
const layerLabel = (
  layer: ResolvedLayer,
  layers: readonly ResolvedLayer[]
): string => {
  const label = `${layer.name} · ${layer.unit}`;
  const ambiguous = layers.some(
    (other) => other !== layer && other.name === layer.name
  );
  return ambiguous ? `${label} (${layer.score})` : label;
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
  layer: ResolvedLayer;
  field: CategoricalField;
  highlighted: readonly string[];
  palette: Palette;
  onToggle: (option: string) => void;
  onClear: () => void;
}> = ({ layer, field, highlighted, palette, onToggle, onClear }) => (
  <div className={styles.options} role="group" aria-label="Options">
    {countOptions(layer, field).map(({ option, count }) => {
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
