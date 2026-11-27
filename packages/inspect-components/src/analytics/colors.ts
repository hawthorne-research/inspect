import {
  optionColor,
  type CategoricalField,
  type OptionColor,
  type Palette,
} from "../chat/annotations/model";

// Neutral, so they never look like a marker: the annotation schemes'
// hues colour the markers, and every scheme has blues, oranges and so on.
// The first series is the theme's text colour, the second a grey.
const kSeriesColors = {
  light: ["#212529", "#8a9199"],
  dark: ["#e9ecef", "#7d848c"],
} as const;

/** The line colour of series `index` (0 or 1) in the theme. */
export const seriesColor = (index: number, dark: boolean): string =>
  kSeriesColors[dark ? "dark" : "light"][index] ?? "currentColor";

/** The rule colour of a marker option: its annotation colour in the
 *  palette, the same as its tint in the Messages tab. */
export const markerColor = (
  field: CategoricalField,
  option: string,
  palette: Palette
): OptionColor => optionColor(field, option, palette) ?? kNoColor;

const kNoColor: OptionColor = { color: "currentColor", hatched: false };
