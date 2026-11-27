import * as Plot from "@observablehq/plot";
import { FC } from "react";

import { formatValue, type Palette } from "../chat/annotations/model";

import { markerColor, seriesColor } from "./colors";
import type { AlongTranscript, Panel, PanelMarker, PanelPoint } from "./model";

export interface PanelPlotProps {
  panel: Panel;
  view: AlongTranscript;
  palette: Palette;
  width: number;
  height: number;
  onSelect: (panel: Panel, point: PanelPoint) => void;
}

/** One panel of the "along the transcript" view, drawn by Observable Plot;
 *  loaded on demand, as Plot and d3 are large. */
const PanelPlot: FC<PanelPlotProps> = ({
  panel,
  view,
  palette,
  width,
  height,
  onSelect,
}) => {
  // A ref callback with cleanup: the plot is rebuilt whenever an input
  // changes, and removed with the element.
  const mount = (container: HTMLDivElement | null) => {
    if (!container) return;
    const plot = panelPlot({ panel, view, palette, width, height, onSelect });
    container.append(plot);
    return () => plot.remove();
  };
  return <div ref={mount} />;
};

export default PanelPlot;

/** The plot's inline style. Plot's own defaults arrive in a <style>
 *  element, which the viewer's Content-Security-Policy (style-src-elem
 *  'self') blocks, so they are removed and restated here, with the page's
 *  background behind tooltips. */
const kPlotStyle = [
  "--plot-background: var(--bs-body-bg)",
  "display: block",
  "max-width: 100%",
  "height: auto",
  "overflow: visible",
  "white-space: pre",
  "cursor: pointer",
].join("; ");

const panelPlot = ({
  panel,
  view,
  palette,
  width,
  height,
  onSelect,
}: PanelPlotProps): Element => {
  const { series, rightAxis, marker } = view;
  const [left, right] = series;
  const toPlot = (index: number, value: number): number =>
    index === 1 && rightAxis ? rightAxis.forward(value) : value;
  const y = (point: PanelPoint, index: number): number => {
    const value = point.values[index];
    return value === null || value === undefined
      ? Number.NaN
      : toPlot(index, value);
  };
  // The right axis's ticks at their places on the plot's y scale, labelled
  // with their own values (inverting the map would add rounding noise).
  const rightTicks = new Map(
    rightAxis && right
      ? right.ticks.map((tick) => [rightAxis.forward(tick), tick])
      : []
  );
  const [lo, hi] = view.yDomain;
  const tipY = (point: PanelPoint): number => {
    const first = point.values.findIndex((v) => v !== null);
    return first < 0 ? (lo + hi) / 2 : y(point, first);
  };

  const colorOf = (m: PanelMarker) =>
    marker ? markerColor(marker.field, m.option, palette) : undefined;
  const solid = panel.markers.filter((m) => !colorOf(m)?.hatched);
  const hatched = panel.markers.filter((m) => colorOf(m)?.hatched);
  const markerRule = (markers: readonly PanelMarker[], dashed: boolean) =>
    Plot.ruleX(markers, {
      x: "x",
      stroke: (m: PanelMarker) => colorOf(m)?.color,
      strokeWidth: 1.5,
      strokeOpacity: 0.8,
      strokeDasharray: dashed ? "3,2" : undefined,
      ariaDescription: "markers",
    });

  const unit = view.unit;
  const tipText = (point: PanelPoint): string =>
    [
      `${unit} ${point.x} of ${panel.spanCount} · message index ${point.messageIndex}`,
      ...series.map((s, i) => {
        const value = point.values[i];
        return `${s.layer} · ${s.field}: ${value === null || value === undefined ? "—" : formatValue(value)}`;
      }),
      ...(marker ? [`${marker.label}: ${point.marker ?? "—"}`] : []),
      "Click to open in Messages",
    ].join("\n");

  const plot = Plot.plot({
    width,
    height,
    marginTop: 12,
    marginLeft: 40,
    marginRight: right ? 44 : 16,
    marginBottom: 32,
    style: kPlotStyle,
    x: { domain: [0, panel.spanCount] },
    y: { domain: [lo, hi] },
    color: { type: "identity" },
    marks: [
      Plot.ruleX(panel.boundaries, {
        stroke: "currentColor",
        strokeOpacity: 0.18,
        ariaDescription: "message starts",
      }),
      markerRule(solid, false),
      markerRule(hatched, true),
      ...series.map((s, i) =>
        s.reference === null
          ? null
          : Plot.ruleY([toPlot(i, s.reference)], {
              stroke: seriesColor(i, palette.dark),
              strokeDasharray: "4,3",
              strokeOpacity: 0.8,
              clip: true,
              ariaDescription: "reference",
            })
      ),
      ...series.map((_, i) =>
        Plot.line(panel.points, {
          x: "x",
          y: (point: PanelPoint) => y(point, i),
          stroke: seriesColor(i, palette.dark),
          strokeWidth: 1.5,
          // A fixed axis range can leave values outside the frame.
          clip: true,
          ariaDescription: `series ${i + 1}`,
        })
      ),
      Plot.axisX({
        ticks: 6,
        label: `${unit.charAt(0).toUpperCase()}${unit.slice(1)} in the sample`,
        labelAnchor: "center",
        labelArrow: "none",
      }),
      left
        ? Plot.axisY(left.ticks, { anchor: "left", tickFormat: formatValue })
        : null,
      right && rightAxis
        ? Plot.axisY([...rightTicks.keys()], {
            anchor: "right",
            tickFormat: (tick: number) =>
              formatValue(rightTicks.get(tick) ?? rightAxis.inverse(tick)),
            ariaDescription: "right axis",
          })
        : null,
      Plot.ruleX(
        panel.points,
        Plot.pointerX({
          x: "x",
          stroke: "currentColor",
          strokeOpacity: 0.35,
        })
      ),
      Plot.tip(
        panel.points,
        Plot.pointerX({ x: "x", y: tipY, title: tipText })
      ),
    ],
  });
  for (const style of plot.querySelectorAll("style")) style.remove();
  plot.addEventListener("click", () => {
    const value: unknown = plot.value;
    const point = panel.points.find((p) => p === value);
    if (point) onSelect(panel, point);
  });
  return plot;
};
