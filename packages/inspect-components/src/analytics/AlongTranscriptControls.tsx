import { FC, ReactNode } from "react";

import type { Aggregation } from "../chat/annotations/model";

import styles from "./AlongTranscript.module.css";
import {
  kAggregations,
  kMaxColumns,
  layerFields,
  type AlongTranscript,
  type AlongTranscriptParams,
  type FieldRef,
  type LayerInfo,
  type SeriesParams,
} from "./model";

interface AlongTranscriptControlsProps {
  params: AlongTranscriptParams;
  /** The view of `params`, which tells which series are rolled up;
   *  undefined when it couldn't be drawn. */
  view: AlongTranscript | undefined;
  layers: readonly LayerInfo[];
  /** Scores the panels can be grouped by. */
  scores: readonly string[];
  /** Leaves out the settings that only arrange several samples' panels
   *  (group by, columns). */
  oneSample?: boolean;
  onChange: (params: AlongTranscriptParams) => void;
}

const kNone = "";

/** A typed number, null when empty, undefined while not a number. */
const numberInput = (text: string): number | null | undefined => {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
};
const refValue = (ref: FieldRef | undefined | null): string =>
  ref ? JSON.stringify([ref.layer, ref.field]) : kNone;

/** Selects for the parameters of the "along the transcript" view. */
export const AlongTranscriptControls: FC<AlongTranscriptControlsProps> = ({
  params,
  view,
  layers,
  scores,
  oneSample = false,
  onChange,
}) => {
  const unit = layers.find((layer) => layer.name === params.x)?.unit ?? "span";
  const numeric = layerFields(layers, "numeric");
  const categorical = layerFields(layers, "categorical");
  const update = (changes: Partial<AlongTranscriptParams>) =>
    onChange({ ...params, ...changes });

  const setSeries = (index: number, series: SeriesParams | null) => {
    const next = [...params.series];
    if (series) next[index] = series;
    else next.splice(index, 1);
    update({ series: next });
  };

  const seriesControls = (index: number, label: string) => {
    const current = params.series[index];
    const rolledUp =
      view?.series[index]?.rolledUp ??
      (current !== undefined && current.layer !== params.x);
    return (
      <Control label={label}>
        <select
          aria-label={`${label} series`}
          className={styles.select}
          value={refValue(current)}
          disabled={index > params.series.length}
          onChange={(e) => {
            const ref = fromRefValue(e.target.value, numeric);
            setSeries(
              index,
              ref
                ? {
                    ...ref,
                    aggregation: current?.aggregation ?? "mean",
                    reference: null,
                    min: null,
                    max: null,
                  }
                : null
            );
          }}
        >
          <option value={kNone}>none</option>
          {numeric.map((ref) => (
            <option key={refValue(ref)} value={refValue(ref)}>
              {ref.layer} · {ref.field}
            </option>
          ))}
        </select>
        {current && rolledUp ? (
          <select
            aria-label={`${label} aggregation per ${unit}`}
            className={styles.select}
            value={current.aggregation}
            title={`Combines the values within each ${unit}`}
            onChange={(e) => {
              const aggregation = kAggregations.find(
                (a) => a === e.target.value
              );
              if (aggregation) setSeries(index, { ...current, aggregation });
            }}
          >
            {kAggregations.map((a: Aggregation) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        ) : null}
        {current ? (
          <input
            // Uncontrolled, so a half-typed number ("0.", "-") isn't
            // rewritten; a new series starts it afresh.
            key={refValue(current)}
            type="number"
            step="any"
            aria-label={`${label} reference`}
            placeholder="ref"
            title="Draws a dashed reference line at this value"
            className={styles.number}
            defaultValue={current.reference ?? ""}
            onChange={(e) => {
              const reference = numberInput(e.target.value);
              if (reference !== undefined) {
                setSeries(index, { ...current, reference });
              }
            }}
          />
        ) : null}
        {current
          ? (["min", "max"] as const).map((end) => (
              <input
                key={`${refValue(current)}-${end}`}
                type="number"
                step="any"
                aria-label={`${label} axis ${end}`}
                placeholder={end}
                title={`Fixes the ${end === "min" ? "bottom" : "top"} of the axis; empty fits it to the data`}
                className={styles.number}
                defaultValue={current[end] ?? ""}
                onChange={(e) => {
                  const value = numberInput(e.target.value);
                  if (value !== undefined) {
                    setSeries(index, { ...current, [end]: value });
                  }
                }}
              />
            ))
          : null}
      </Control>
    );
  };

  return (
    <div className={styles.controls} role="group" aria-label="View settings">
      <Control label="Spans">
        <select
          aria-label="Spans"
          className={styles.select}
          value={params.x}
          onChange={(e) => update({ x: e.target.value })}
        >
          {layers.map((layer) => (
            <option key={layer.name} value={layer.name}>
              {layer.name} · {layer.unit}
            </option>
          ))}
        </select>
      </Control>
      {seriesControls(0, "Left")}
      {seriesControls(1, "Right")}
      <Control label="Markers">
        <select
          aria-label="Markers"
          className={styles.select}
          value={refValue(params.marker)}
          onChange={(e) =>
            update({ marker: fromRefValue(e.target.value, categorical) })
          }
        >
          <option value={kNone}>none</option>
          {categorical.map((ref) => (
            <option key={refValue(ref)} value={refValue(ref)}>
              {ref.layer} · {ref.field}
            </option>
          ))}
        </select>
      </Control>
      {oneSample ? null : (
        <>
          <Control label="Group by">
            <select
              aria-label="Group by"
              className={styles.select}
              value={params.groupBy ?? kNone}
              onChange={(e) =>
                update({
                  groupBy: e.target.value === kNone ? null : e.target.value,
                })
              }
            >
              <option value={kNone}>none</option>
              {scores.map((score) => (
                <option key={score} value={score}>
                  {score}
                </option>
              ))}
            </select>
          </Control>
          <Control label="Columns">
            <select
              aria-label="Columns"
              className={styles.select}
              value={params.columns}
              onChange={(e) => update({ columns: Number(e.target.value) })}
            >
              {Array.from({ length: kMaxColumns }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Control>
        </>
      )}
      <label className={styles.control}>
        <input
          type="checkbox"
          checked={params.messageBoundaries}
          onChange={(e) => update({ messageBoundaries: e.target.checked })}
        />
        Message starts
      </label>
    </div>
  );
};

const Control: FC<{ label: string; children: ReactNode }> = ({
  label,
  children,
}) => (
  <span className={styles.control}>
    <span className={styles.controlLabel}>{label}</span>
    {children}
  </span>
);

const fromRefValue = (
  value: string,
  refs: readonly FieldRef[]
): FieldRef | null => refs.find((ref) => refValue(ref) === value) ?? null;
