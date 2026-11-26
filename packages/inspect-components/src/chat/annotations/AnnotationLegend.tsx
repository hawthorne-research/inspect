import clsx from "clsx";
import { FC } from "react";

import { SegmentedControl } from "@tsmono/react/components";

import styles from "./AnnotationLegend.module.css";
import { countOptions, optionStyle } from "./categorical";
import {
  fieldLabel,
  metadataText,
  spanCountLabel,
  type AnnotationField,
  type CategoricalField,
} from "./format";
import type { ResolvedLayer } from "./layers";
import { formatValue } from "./numeric";
import { OverviewStrip } from "./OverviewStrip";
import { SpanTooltip } from "./SpanTooltip";
import type { SpanLocation, StripSegment } from "./strip";
import { Swatch } from "./Swatch";
import type { AnnotationView } from "./view";

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
            ...Object.entries(layer.metadata).map(
              ([key, value]) => `${key}: ${metadataText(value)}`
            ),
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
      </div>
      {field.type === "categorical" ? (
        <OptionKey
          layer={layer}
          field={field}
          highlighted={view.highlighted}
          onToggle={onToggleHighlight}
          onClear={onClearHighlight}
        />
      ) : (
        <ColorBar scale={view.scale} />
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
  <span
    className={styles.fieldPicker}
    title={
      selected.description
        ? `${selected.name}: ${selected.description}`
        : undefined
    }
  >
    <span className="text-style-secondary">Color by</span>
    {fields.length <= kMaxSegmentedFields &&
    fields.every((f) => fieldLabel(f).length <= kMaxSegmentedLabel) ? (
      <SegmentedControl
        segments={fields.map((f) => ({ id: f.name, label: fieldLabel(f) }))}
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
          <option
            key={f.name}
            value={f.name}
            title={f.description ?? undefined}
          >
            {fieldLabel(f)}
          </option>
        ))}
      </select>
    )}
  </span>
);

/** Each option's tint and count; clicking options highlights their
 *  spans. */
const OptionKey: FC<{
  layer: ResolvedLayer;
  field: CategoricalField;
  highlighted: readonly string[];
  onToggle: (option: string) => void;
  onClear: () => void;
}> = ({ layer, field, highlighted, onToggle, onClear }) => (
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
          <Swatch fill={optionStyle(field, option, [])} />
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

const ColorBar: FC<{ scale: number }> = ({ scale }) =>
  scale > 0 ? (
    <span
      className={styles.colorBar}
      title={`Values at or beyond ±${formatValue(scale)} (the 99th percentile of |value| for this field) get full colour`}
    >
      <span className={styles.gradient} />
      <span className={styles.ticks}>
        <span>{formatValue(-scale)}</span>
        <span>0</span>
        <span>{formatValue(scale)}</span>
      </span>
    </span>
  ) : (
    <span className={styles.noScale}>all values are 0</span>
  );
