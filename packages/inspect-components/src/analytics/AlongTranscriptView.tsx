import clsx from "clsx";
import { FC, lazy, Suspense, useState } from "react";

import { useResizeObserver } from "@tsmono/react/hooks";

import {
  formatValue,
  isNegative,
  type Palette,
} from "../chat/annotations/model";

import styles from "./AlongTranscript.module.css";
import { markerColor, seriesColor } from "./colors";
import type { AlongTranscript, Panel, PanelPoint } from "./model";

const PanelPlot = lazy(() => import("./PanelPlot"));

const kPanelHeight = 180;
const kGap = 16;
// Until the grid is measured (and in tests, where nothing is).
const kDefaultWidth = 960;

interface AlongTranscriptViewProps {
  view: AlongTranscript;
  palette: Palette;
  /** A click in a panel: the panel and its span nearest the pointer. */
  onSelectSpan: (panel: Panel, point: PanelPoint) => void;
  /** Height of each panel's plot, in pixels. */
  panelHeight?: number;
}

/** The "along the transcript" view: a shared legend, then a small plot per
 *  sample, in groups when the view groups them. */
export const AlongTranscriptView: FC<AlongTranscriptViewProps> = ({
  view,
  palette,
  onSelectSpan,
  panelHeight = kPanelHeight,
}) => {
  const [measured, setMeasured] = useState(0);
  const gridRef = useResizeObserver((entry) =>
    setMeasured(Math.floor(entry.contentRect.width))
  );
  const columns = view.params.columns;
  const width = Math.max(
    160,
    Math.floor(((measured || kDefaultWidth) - kGap * (columns - 1)) / columns)
  );
  const panelCount = view.groups.reduce((n, g) => n + g.panels.length, 0);

  return (
    <div className={styles.view}>
      <Legend view={view} palette={palette} />
      {view.omitted > 0 ? (
        <div className={styles.note}>
          {view.omitted === 1
            ? "1 sample doesn't have every chosen layer and isn't shown."
            : `${view.omitted.toLocaleString()} samples don't have every chosen layer and aren't shown.`}
        </div>
      ) : null}
      <div ref={gridRef}>
        {panelCount === 0 ? (
          <div className={styles.note}>No sample has every chosen layer.</div>
        ) : null}
        {view.groups.map((group) => (
          <section
            key={group.value ?? ""}
            className={styles.group}
            aria-label={
              view.params.groupBy === null
                ? "Samples"
                : `${view.params.groupBy}: ${group.value ?? "no value"}`
            }
          >
            {view.params.groupBy === null ? null : (
              <h3 className={styles.groupTitle}>
                {view.params.groupBy}: {group.value ?? "no value"}
                <span className={styles.groupCount}>
                  {group.panels.length === 1
                    ? "1 sample"
                    : `${group.panels.length} samples`}
                </span>
              </h3>
            )}
            <div
              className={styles.grid}
              style={{
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                gap: kGap,
              }}
            >
              {group.panels.map((panel) => (
                <figure
                  key={`${panel.sample.id}|${panel.sample.epoch}`}
                  className={styles.panel}
                >
                  <figcaption className={styles.panelTitle}>
                    {panel.title}
                  </figcaption>
                  <Suspense fallback={<div style={{ height: panelHeight }} />}>
                    <PanelPlot
                      panel={panel}
                      view={view}
                      palette={palette}
                      width={width}
                      height={panelHeight}
                      onSelect={onSelectSpan}
                    />
                  </Suspense>
                </figure>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
};

const Legend: FC<{ view: AlongTranscript; palette: Palette }> = ({
  view,
  palette,
}) => {
  const { series, marker } = view;
  return (
    <ul className={styles.legend} aria-label="Legend">
      {series.map((s, i) => (
        <li key={s.label} className={styles.legendItem}>
          <span
            className={styles.lineSwatch}
            style={{ backgroundColor: seriesColor(i, palette.dark) }}
          />
          {s.label}
          {series.length > 1 ? (
            <span className={styles.legendNote}>
              {i === 0 ? "left axis" : "right axis"}
            </span>
          ) : null}
          {s.reference === null ? null : (
            <span className={styles.legendNote}>
              <span
                className={styles.dashSwatch}
                style={{ borderColor: seriesColor(i, palette.dark) }}
              />
              {formatValue(s.reference)}
            </span>
          )}
        </li>
      ))}
      {marker ? (
        <li className={styles.legendItem}>
          {marker.label}:
          {marker.field.options
            .filter((option) => !isNegative(marker.field, option))
            .map((option) => {
              const { color, hatched } = markerColor(
                marker.field,
                option,
                palette
              );
              return (
                <span key={option} className={styles.legendOption}>
                  <span
                    className={styles.ruleSwatch}
                    style={{
                      borderColor: color,
                      borderLeftStyle: hatched ? "dashed" : "solid",
                    }}
                  />
                  {option}
                </span>
              );
            })}
        </li>
      ) : null}
      {view.params.messageBoundaries ? (
        <li className={styles.legendItem}>
          <span className={clsx(styles.ruleSwatch, styles.faint)} />
          message start
        </li>
      ) : null}
    </ul>
  );
};
