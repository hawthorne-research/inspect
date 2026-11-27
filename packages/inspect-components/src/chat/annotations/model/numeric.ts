import type { NumericField } from "./format";
import {
  paletteColors,
  textOn,
  withAlpha,
  type Palette,
  type SpanStyle,
} from "./schemes";
import type { ResolvedSet } from "./sets";

/** The quantile of |value| drawn at full colour: a few outliers clip
 *  instead of washing out every other span. */
const kScaleQuantile = 0.99;

/**
 * The magnitude drawn at full colour for `field`: the 99th percentile of
 * |value| over every span of `set`, interpolating linearly between order
 * statistics (numpy's default). 0 when there are no spans.
 */
export const valueScale = (set: ResolvedSet, field: NumericField): number =>
  magnitudeScale(set.parts.map((part) => part.values.get(field.name) ?? []));

const kScales = new WeakMap<ResolvedSet, Map<string, number>>();

/** `valueScale`, computed once per set and field: the view and the
 *  tooltip ask for it on every render and hover, and a large set has
 *  tens of thousands of values to sort. */
export const fieldScale = (set: ResolvedSet, field: NumericField): number => {
  let scales = kScales.get(set);
  if (!scales) {
    scales = new Map();
    kScales.set(set, scales);
  }
  let scale = scales.get(field.name);
  if (scale === undefined) {
    scale = valueScale(set, field);
    scales.set(field.name, scale);
  }
  return scale;
};

/** The 99th percentile of |value| over every value of `sequences`. */
export const magnitudeScale = (
  sequences: readonly (readonly number[])[]
): number => {
  const total = sequences.reduce((sum, values) => sum + values.length, 0);
  const magnitudes = new Float64Array(total);
  let i = 0;
  for (const values of sequences) {
    for (const value of values) magnitudes[i++] = Math.abs(value);
  }
  magnitudes.sort();
  return quantile(magnitudes, kScaleQuantile);
};

/** The `q` quantile of ascending `sorted`, linearly interpolated. */
export const quantile = (sorted: Float64Array, q: number): number => {
  if (sorted.length === 0) return 0;
  const position = q * (sorted.length - 1);
  const lower = Math.floor(position);
  const below = sorted[lower] ?? 0;
  const above = sorted[Math.min(lower + 1, sorted.length - 1)] ?? below;
  return below + (position - lower) * (above - below);
};

/** `value / scale` clipped to [-1, 1]: the signed share of full colour.
 *  0 when the scale is 0, so an all-zero field draws nothing. */
export const valueIntensity = (value: number, scale: number): number =>
  scale > 0 ? Math.max(-1, Math.min(1, value / scale)) : 0;

/** Steps of opacity a shade is rounded to, so tens of thousands of spans
 *  share a few hundred style objects and React's style diff is a no-op for
 *  spans whose colour didn't change. */
const kSteps = 100;

const kStyles = new Map<string, (SpanStyle | undefined)[]>();

/** The shades of one sign's hue in `palette`, from clear to full. */
const shades = (
  palette: Palette,
  sign: "negative" | "positive"
): (SpanStyle | undefined)[] => {
  const key = `${palette.scheme.id}|${palette.dark}|${sign}`;
  const cached = kStyles.get(key);
  if (cached) return cached;
  const hue = paletteColors(palette)[sign];
  const styles = Array.from({ length: kSteps + 1 }, (_, step) => {
    if (step === 0) return undefined;
    const alpha = (step / kSteps) * palette.scheme.maxShade;
    return {
      backgroundColor: withAlpha(hue, alpha),
      color: textOn(hue, alpha, palette.dark),
    };
  });
  kStyles.set(key, styles);
  return styles;
};

/**
 * A span's background in `palette`: the hue of its sign at an opacity
 * proportional to |value| / scale, up to the scheme's `maxShade`, with
 * black or white text, whichever reads better on it. Undefined when that
 * rounds to nothing, so zero stays uncoloured.
 */
export const valueStyle = (
  value: number,
  scale: number,
  palette: Palette
): SpanStyle | undefined => {
  const intensity = valueIntensity(value, scale);
  const step = Math.round(Math.abs(intensity) * kSteps);
  return shades(palette, intensity > 0 ? "positive" : "negative")[step];
};

/** A value in three significant figures, switching to exponent notation
 *  for very large or small magnitudes. */
export const formatValue = (value: number): string => {
  if (value === 0) return "0";
  const magnitude = Math.abs(value);
  if (magnitude >= 1e4 || magnitude < 1e-3) return value.toExponential(2);
  return String(Number(value.toPrecision(3)));
};

/** The index of the value of largest magnitude in `values` (the first, on
 *  ties); 0 when empty. */
export const peakIndex = (values: readonly number[]): number => {
  let peak = 0;
  for (let i = 1; i < values.length; i++) {
    if (Math.abs(values[i] ?? 0) > Math.abs(values[peak] ?? 0)) peak = i;
  }
  return peak;
};
