import * as Plot from "@observablehq/plot";
import { FC } from "react";

import { formatValue, type Palette } from "../chat/annotations/model";

import { kReferenceDash, markerColor, seriesStyle } from "./colors";
import {
  kPlotDomain,
  type AlongTranscript,
  type Panel,
  type PanelMarker,
  type PanelPoint,
  type YAxis,
} from "./model";

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

// Plot's text is 10px; its y axes put text 3px past 6px ticks. Text widths
// are estimated, not measured, so every panel gets the same margins: tick
// values by their widest characters, digits, and labels by an average one.
const kTickSize = 6;
const kTickPadding = 3;
const kCharWidth = 6;
const kLabelCharWidth = 5.5;
// Room for a tick value on the x axis, e.g. "150" with space around it.
const kXTickSpacing = 45;
const kLabelHeight = 12;
const kLabelGap = 4;
const kAxisGap = 10;
const kMarginTop = 12;
const kMarginBottom = 32;
const kBareMargin = 16;

interface AxisPlace {
  axis: YAxis;
  /** From the frame's edge outwards, in pixels. */
  offset: number;
  /** Ticks, their values and the label. */
  width: number;
}

/** Where each axis goes beside the frame, outwards in order on its side,
 *  and the margins that fit them. */
const placeAxes = (
  axes: readonly YAxis[]
): { places: AxisPlace[]; marginLeft: number; marginRight: number } => {
  const used = { left: 0, right: 0 };
  const places = axes.map((axis): AxisPlace => {
    const chars = Math.max(0, ...axis.ticks.map((t) => formatValue(t).length));
    const width =
      kTickSize + kTickPadding + chars * kCharWidth + kLabelGap + kLabelHeight;
    const offset = used[axis.side] === 0 ? 0 : used[axis.side] + kAxisGap;
    used[axis.side] = offset + width;
    return { axis, offset, width };
  });
  return {
    places,
    marginLeft: used.left === 0 ? kBareMargin : used.left + 2,
    marginRight: used.right === 0 ? kBareMargin : used.right + 2,
  };
};

/** `text` cut to `chars` characters, ending in an ellipsis when cut. */
const truncate = (text: string, chars: number): string =>
  text.length <= chars ? text : `${text.slice(0, Math.max(0, chars - 1))}…`;

const panelPlot = ({
  panel,
  view,
  palette,
  width,
  height,
  onSelect,
}: PanelPlotProps): Element => {
  const { series, axes, marker } = view;
  const styleOf = (index: number) => seriesStyle(index, palette.dark);
  const axisOf = (index: number): YAxis | undefined => {
    const s = series[index];
    return s === undefined ? undefined : axes[s.axis];
  };
  const y = (point: PanelPoint, index: number): number => {
    const value = point.values[index];
    const axis = axisOf(index);
    return value === null || value === undefined || !axis
      ? Number.NaN
      : axis.toPlot(value);
  };
  const [lo, hi] = kPlotDomain;
  const tipY = (point: PanelPoint): number => {
    const first = point.values.findIndex((v) => v !== null);
    return first < 0 ? (lo + hi) / 2 : y(point, first);
  };

  const { places, marginLeft, marginRight } = placeAxes(axes);
  const labelChars = Math.floor(
    (height - kMarginTop - kMarginBottom) / kLabelCharWidth
  );
  // Axes beside the frame narrow it, so fewer x ticks fit.
  const xTicks = Math.max(
    2,
    Math.min(6, Math.floor((width - marginLeft - marginRight) / kXTickSpacing))
  );
  const axisMarks = ({ axis, offset, width: axisWidth }: AxisPlace) => {
    const outwards = axis.side === "left" ? -1 : 1;
    // Each tick at its place on the plot's y scale, labelled with its own
    // value (mapping back would add rounding noise).
    const ticks = new Map(axis.ticks.map((tick) => [axis.toPlot(tick), tick]));
    const [only, ...others] = axis.series;
    const label = truncate(axis.label, labelChars);
    return [
      // Only axes away from the frame get a spine, which the frame's edge is
      // for the others.
      axis.position > 0
        ? Plot.frame({ anchor: axis.side, dx: outwards * offset })
        : null,
      Plot.axisY([...ticks.keys()], {
        anchor: axis.side,
        dx: outwards * offset,
        tickFormat: (at: number) => {
          const tick = ticks.get(at);
          return tick === undefined ? "" : formatValue(tick);
        },
        label: null,
        ariaDescription: `axis ${axis.index + 1}`,
      }),
      Plot.text([label], {
        text: (text: string) => text,
        frameAnchor: axis.side,
        textAnchor: "middle",
        rotate: -90,
        lineAnchor: axis.side === "left" ? "top" : "bottom",
        dx: outwards * (offset + axisWidth),
        fill:
          only !== undefined && others.length === 0
            ? styleOf(only).color
            : "currentColor",
        title: label === axis.label ? undefined : () => axis.label,
        ariaDescription: `axis ${axis.index + 1} label`,
      }),
    ];
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

  const noun = view.spanNoun;
  const tipText = (point: PanelPoint): string =>
    [
      `${noun} ${point.x} of ${panel.spanCount} · message index ${point.messageIndex}`,
      ...series.map((s, i) => {
        const value = point.values[i];
        return `${s.label}: ${value === null || value === undefined ? "—" : formatValue(value)}`;
      }),
      ...(marker ? [`${marker.label}: ${point.marker ?? "—"}`] : []),
      "Click to open in Messages",
    ].join("\n");

  const plot = Plot.plot({
    width,
    height,
    marginTop: kMarginTop,
    marginLeft,
    marginRight,
    marginBottom: kMarginBottom,
    style: kPlotStyle,
    x: { domain: [0, panel.spanCount] },
    y: { domain: [lo, hi], axis: null },
    color: { type: "identity" },
    marks: [
      Plot.ruleX(panel.boundaries, {
        stroke: "currentColor",
        strokeOpacity: 0.18,
        ariaDescription: "message starts",
      }),
      markerRule(solid, false),
      markerRule(hatched, true),
      ...series.map((s, i) => {
        const axis = axisOf(i);
        return s.reference === null || !axis
          ? null
          : Plot.ruleY([axis.toPlot(s.reference)], {
              stroke: styleOf(i).color,
              strokeDasharray: kReferenceDash,
              strokeOpacity: 0.8,
              clip: true,
              ariaDescription: "reference",
            });
      }),
      ...series.map((_, i) =>
        Plot.line(panel.points, {
          x: "x",
          y: (point: PanelPoint) => y(point, i),
          stroke: styleOf(i).color,
          strokeDasharray: styleOf(i).dash,
          strokeWidth: 1.5,
          // A fixed axis range can leave values outside the frame.
          clip: true,
          ariaDescription: `series ${i + 1}`,
        })
      ),
      Plot.axisX({
        ticks: xTicks,
        label: `${noun.charAt(0).toUpperCase()}${noun.slice(1)} in the sample`,
        labelAnchor: "center",
        labelArrow: "none",
      }),
      ...places.flatMap(axisMarks),
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
