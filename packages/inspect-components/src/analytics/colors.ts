import {
  optionColor,
  type CategoricalField,
  type OptionColor,
  type Palette,
} from "../chat/annotations/model";

// Neutral, so they never look like a marker: the annotation schemes'
// hues colour the markers, and every scheme has blues, oranges and so on.
// Series alternate the theme's text colour and a grey, solid, then dashed,
// then dotted.
const kSeriesColors = {
  light: ["#212529", "#8a9199"],
  dark: ["#e9ecef", "#7d848c"],
} as const;
const kSeriesDashes = [undefined, "6,3", "1.5,2.5"] as const;

/** The dash of reference lines, which are thinner than series. */
export const kReferenceDash = "4,3";

export interface LineStyle {
  color: string;
  /** An SVG stroke-dasharray; undefined for a solid line. */
  dash: string | undefined;
}

/** The line style of series `index` in the theme. */
export const seriesStyle = (index: number, dark: boolean): LineStyle => ({
  color: kSeriesColors[dark ? "dark" : "light"][index % 2] ?? "currentColor",
  dash: kSeriesDashes[Math.floor(index / 2) % kSeriesDashes.length],
});

/** The rule colour of a marker option: its annotation colour in the
 *  palette, the same as its tint in the Messages tab. */
export const markerColor = (
  field: CategoricalField,
  option: string,
  palette: Palette
): OptionColor => optionColor(field, option, palette) ?? kNoColor;

const kNoColor: OptionColor = { color: "currentColor", hatched: false };
