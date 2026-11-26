import type { CSSProperties } from "react";

import type { NumericField } from "./format";
import type { ResolvedLayer } from "./layers";

/** Opacity of a span's background at full intensity: strong enough to
 *  read, weak enough that text keeps its contrast in both themes. */
export const kMaxValueAlpha = 0.8;

/** The quantile of |value| drawn at full colour: a few outliers clip
 *  instead of washing out every other span. */
const kScaleQuantile = 0.99;

/**
 * The magnitude drawn at full colour for `field`: the 99th percentile of
 * |value| over every span of `layer`, interpolating linearly between order
 * statistics (numpy's default). 0 when there are no spans.
 */
export const valueScale = (layer: ResolvedLayer, field: NumericField): number =>
  magnitudeScale(layer.parts.map((part) => part.values.get(field.name) ?? []));

const kScales = new WeakMap<ResolvedLayer, Map<string, number>>();

/** `valueScale`, computed once per layer and field: the view and the
 *  tooltip ask for it on every render and hover, and a large layer has
 *  tens of thousands of values to sort. */
export const fieldScale = (
  layer: ResolvedLayer,
  field: NumericField
): number => {
  let scales = kScales.get(layer);
  if (!scales) {
    scales = new Map();
    kScales.set(layer, scales);
  }
  let scale = scales.get(field.name);
  if (scale === undefined) {
    scale = valueScale(layer, field);
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

const kSteps = Math.round(kMaxValueAlpha * 100);

const background = (hue: "positive" | "negative", percent: number): string =>
  `color-mix(in srgb, var(--inspect-annotation-value-${hue}) ${percent}%, transparent)`;

// One shared style per sign and opacity percent, so tens of thousands of
// spans reuse a few hundred objects and React's style diff is a no-op for
// spans whose colour didn't change.
const kStyles = {
  positive: Array.from({ length: kSteps + 1 }, (_, p) =>
    p === 0 ? undefined : { backgroundColor: background("positive", p) }
  ),
  negative: Array.from({ length: kSteps + 1 }, (_, p) =>
    p === 0 ? undefined : { backgroundColor: background("negative", p) }
  ),
} satisfies Record<string, (CSSProperties | undefined)[]>;

/**
 * A span's background: the hue of its sign at an opacity proportional to
 * |value| / scale, up to `kMaxValueAlpha`, in whole percent. Undefined
 * when that rounds to nothing, so zero stays uncoloured.
 */
export const valueStyle = (
  value: number,
  scale: number
): CSSProperties | undefined => {
  const intensity = valueIntensity(value, scale);
  const percent = Math.round(Math.abs(intensity) * kSteps);
  return (intensity > 0 ? kStyles.positive : kStyles.negative)[percent];
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
