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

/** The overview strip's resolution. */
export const kMaxBins = 300;

/** One bin of the overview strip. */
export interface ValueBin {
  /** How many spans the bin holds. */
  count: number;
  /** The bin's value of largest magnitude (the first, on ties). */
  peak: number;
  /** Where the peak is: its sequence, and its index there. */
  sequence: number;
  span: number;
}

/**
 * The values of `sequences`, in order, cut into at most `maxBins` bins of
 * equal count (sizes differ by at most one). Each bin reports its value of
 * largest magnitude, so a single spike stays visible however many spans
 * share its bin. Fewer values than bins gives one bin per value.
 */
export const binValues = (
  sequences: readonly (readonly number[])[],
  maxBins: number = kMaxBins
): ValueBin[] => {
  const total = sequences.reduce((sum, values) => sum + values.length, 0);
  const binCount = Math.min(maxBins, total);
  const bins: ValueBin[] = [];
  let current: ValueBin | undefined;
  let seen = 0;
  let binEnd = Math.floor(total / binCount);
  for (const [sequence, values] of sequences.entries()) {
    for (let span = 0; span < values.length; span++) {
      const value = values[span] ?? 0;
      if (!current) {
        current = { count: 0, peak: value, sequence, span };
      } else if (Math.abs(value) > Math.abs(current.peak)) {
        current.peak = value;
        current.sequence = sequence;
        current.span = span;
      }
      current.count += 1;
      seen += 1;
      if (seen === binEnd) {
        bins.push(current);
        current = undefined;
        binEnd = Math.floor(((bins.length + 1) * total) / binCount);
      }
    }
  }
  return bins;
};
