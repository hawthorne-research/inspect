import clsx from "clsx";
import { FC, ReactNode } from "react";

import { spanNoun, type Aggregation } from "../chat/annotations/model";

import styles from "./AlongTranscript.module.css";
import {
  axisName,
  kAggregations,
  kMaxColumns,
  normalizeAxes,
  setFields,
  type AlongTranscript,
  type AlongTranscriptParams,
  type AxisParams,
  type FieldRef,
  type SeriesParams,
  type SetInfo,
} from "./model";

interface AlongTranscriptControlsProps {
  params: AlongTranscriptParams;
  /** The view of `params`, which tells which series are rolled up;
   *  undefined when it couldn't be drawn. */
  view: AlongTranscript | undefined;
  sets: readonly SetInfo[];
  /** Scores the panels can be grouped by. */
  scores: readonly string[];
  /** Leaves out the settings that only arrange several samples' panels
   *  (group by, columns). */
  oneSample?: boolean;
  onChange: (params: AlongTranscriptParams) => void;
}

const kNone = "";
const kFittedAxis: AxisParams = { min: null, max: null };

/** A typed number, null when empty, undefined while not a number. */
const numberInput = (text: string): number | null | undefined => {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
};
const refValue = (ref: FieldRef | undefined | null): string =>
  ref ? JSON.stringify([ref.set, ref.field]) : kNone;

/** Selects for the parameters of the "along the transcript" view, with a
 *  row per series. */
export const AlongTranscriptControls: FC<AlongTranscriptControlsProps> = ({
  params,
  view,
  sets,
  scores,
  oneSample = false,
  onChange,
}) => {
  const noun = spanNoun(
    sets.find((set) => set.name === params.x)?.unit ?? null
  );
  const numeric = setFields(sets, "numeric");
  const categorical = setFields(sets, "categorical");
  const update = (changes: Partial<AlongTranscriptParams>) =>
    onChange({ ...params, ...changes });
  const updateSeries = (
    series: readonly SeriesParams[],
    axes: readonly AxisParams[] = params.axes
  ) => update(normalizeAxes({ series, axes }));
  const replaceSeries = (index: number, series: SeriesParams) =>
    params.series.map((s, i) => (i === index ? series : s));
  const setAxis = (index: number, axis: AxisParams) =>
    update({ axes: params.axes.map((a, i) => (i === index ? axis : a)) });
  const seriesOn = (axis: number) =>
    params.series.flatMap((s, i) => (s.axis === axis ? [i] : []));

  const addSeries = () => {
    const [field] = numeric;
    if (!field) return;
    updateSeries([
      ...params.series,
      {
        ...field,
        aggregation: "mean",
        reference: null,
        axis: params.axes.length,
      },
    ]);
  };

  const seriesRow = (current: SeriesParams, index: number) => {
    const label = `Series ${index + 1}`;
    const rolledUp = view?.series[index]?.rolledUp ?? current.set !== params.x;
    const onAxis = seriesOn(current.axis);
    const alone = onAxis.length === 1;
    const axis = params.axes[current.axis] ?? kFittedAxis;
    const axisLabel = `Axis ${current.axis + 1}`;
    return (
      <div
        key={index}
        className={styles.seriesRow}
        role="group"
        aria-label={label}
      >
        <span className={styles.controlLabel}>{label}</span>
        <select
          aria-label={`${label} field`}
          className={clsx(styles.select, styles.fieldSelect)}
          value={refValue(current)}
          onChange={(e) => {
            const ref = fromRefValue(e.target.value, numeric);
            if (!ref) return;
            // A field in other units starts its own axis afresh.
            updateSeries(
              replaceSeries(index, { ...current, ...ref, reference: null }),
              alone
                ? params.axes.map((a, i) =>
                    i === current.axis ? kFittedAxis : a
                  )
                : params.axes
            );
          }}
        >
          {numeric.map((ref) => (
            <option key={refValue(ref)} value={refValue(ref)}>
              {ref.set} · {ref.field}
            </option>
          ))}
        </select>
        {rolledUp ? (
          <span className={styles.control}>
            <select
              aria-label={`${label} aggregation`}
              className={styles.select}
              value={current.aggregation}
              title={`Combines the values within each ${noun}`}
              onChange={(e) => {
                const aggregation = kAggregations.find(
                  (a) => a === e.target.value
                );
                if (aggregation) {
                  updateSeries(
                    replaceSeries(index, { ...current, aggregation })
                  );
                }
              }}
            >
              {kAggregations.map((a: Aggregation) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            <span className={styles.controlLabel}>per {noun}</span>
          </span>
        ) : (
          <span />
        )}
        <Control label="axis">
          <select
            aria-label={`${label} axis`}
            className={styles.select}
            value={current.axis}
            title="Series on one axis share its range"
            onChange={(e) =>
              updateSeries(
                replaceSeries(index, {
                  ...current,
                  axis: Number(e.target.value),
                })
              )
            }
          >
            {params.axes.map((_, i) => (
              <option key={i} value={i}>
                {i + 1} ({axisName(i)})
              </option>
            ))}
            {alone ? null : (
              <option value={params.axes.length}>new axis</option>
            )}
          </select>
        </Control>
        {onAxis[0] === index ? (
          <Control label="range">
            {(["min", "max"] as const).map((end) => (
              <input
                key={end}
                type="number"
                step="any"
                aria-label={`${axisLabel} ${end}`}
                placeholder={end}
                title={`Fixes the ${end === "min" ? "bottom" : "top"} of axis ${current.axis + 1}; empty fits it to the data`}
                className={styles.number}
                value={axis[end] ?? ""}
                onChange={(e) => {
                  const value = numberInput(e.target.value);
                  if (value !== undefined) {
                    setAxis(current.axis, { ...axis, [end]: value });
                  }
                }}
              />
            ))}
          </Control>
        ) : (
          <span />
        )}
        <Control label="ref">
          <input
            type="number"
            step="any"
            aria-label={`${label} reference`}
            title="Draws a dashed reference line at this value"
            className={styles.number}
            value={current.reference ?? ""}
            onChange={(e) => {
              const reference = numberInput(e.target.value);
              if (reference !== undefined) {
                updateSeries(replaceSeries(index, { ...current, reference }));
              }
            }}
          />
        </Control>
        <button
          type="button"
          className={styles.button}
          aria-label={`Remove series ${index + 1}`}
          title="Remove this series"
          onClick={() =>
            updateSeries(params.series.filter((_, i) => i !== index))
          }
        >
          ×
        </button>
      </div>
    );
  };

  return (
    <div className={styles.controls} role="group" aria-label="View settings">
      <div className={styles.controlRow}>
        <Control label="Spans">
          <select
            aria-label="Spans"
            className={styles.select}
            value={params.x}
            onChange={(e) => update({ x: e.target.value })}
          >
            {sets.map((set) => (
              <option key={set.name} value={set.name}>
                {set.name} · {spanNoun(set.unit)}
              </option>
            ))}
          </select>
        </Control>
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
                {ref.set} · {ref.field}
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
                {Array.from({ length: kMaxColumns }, (_, i) => i + 1).map(
                  (n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  )
                )}
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
      {params.series.length > 0 ? (
        <div className={styles.seriesRows}>{params.series.map(seriesRow)}</div>
      ) : null}
      <div>
        <button
          type="button"
          className={styles.button}
          disabled={numeric.length === 0}
          onClick={addSeries}
        >
          Add series
        </button>
      </div>
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
