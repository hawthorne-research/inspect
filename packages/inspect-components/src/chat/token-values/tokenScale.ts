import type { CSSProperties } from "react";

/** Opacity of a token's background at full intensity: strong enough to
 *  read, weak enough that text keeps its contrast in both themes. */
export const kMaxTokenAlpha = 0.8;

/** The overview strip's resolution. */
export const kMaxTokenBins = 300;

/** The quantile of |value| drawn at full colour: a few outliers clip
 *  instead of washing out every other token. */
const kScaleQuantile = 0.99;

/**
 * The magnitude drawn at full colour: the 99th percentile of |value| over
 * every token of `sequences`, interpolating linearly between order
 * statistics (numpy's default). 0 when there are no tokens.
 */
export const tokenScale = (
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
 *  0 when the scale is 0, so an all-zero probe draws nothing. */
export const tokenIntensity = (value: number, scale: number): number =>
  scale > 0 ? Math.max(-1, Math.min(1, value / scale)) : 0;

const kSteps = Math.round(kMaxTokenAlpha * 100);

const background = (hue: "positive" | "negative", percent: number): string =>
  `color-mix(in srgb, var(--inspect-token-value-${hue}) ${percent}%, transparent)`;

// One shared style per sign and opacity percent, so tens of thousands of
// token spans reuse a few hundred objects and React's style diff is a no-op
// for tokens whose colour didn't change.
const kStyles = {
  positive: Array.from({ length: kSteps + 1 }, (_, p) =>
    p === 0 ? undefined : { backgroundColor: background("positive", p) }
  ),
  negative: Array.from({ length: kSteps + 1 }, (_, p) =>
    p === 0 ? undefined : { backgroundColor: background("negative", p) }
  ),
} satisfies Record<string, (CSSProperties | undefined)[]>;

/**
 * A token's background: the hue of its sign at an opacity proportional to
 * |value| / scale, up to `kMaxTokenAlpha`, in whole percent. Undefined when
 * that rounds to nothing, so zero stays uncoloured.
 */
export const tokenStyle = (
  value: number,
  scale: number
): CSSProperties | undefined => {
  const intensity = tokenIntensity(value, scale);
  const percent = Math.round(Math.abs(intensity) * kSteps);
  return (intensity > 0 ? kStyles.positive : kStyles.negative)[percent];
};

/** One bin of the overview strip. */
export interface TokenBin {
  /** How many tokens the bin holds. */
  count: number;
  /** The bin's value of largest magnitude (the first, on ties). */
  peak: number;
  /** Where the peak token is: its sequence, and its index there. */
  sequence: number;
  token: number;
}

/**
 * The tokens of `sequences`, in order, cut into at most `maxBins` bins of
 * equal count (sizes differ by at most one). Each bin reports its value of
 * largest magnitude, so a single spike stays visible however many tokens
 * share its bin. Fewer tokens than bins gives one bin per token.
 */
export const binTokens = (
  sequences: readonly (readonly number[])[],
  maxBins: number = kMaxTokenBins
): TokenBin[] => {
  const total = sequences.reduce((sum, values) => sum + values.length, 0);
  const binCount = Math.min(maxBins, total);
  const bins: TokenBin[] = [];
  let current: TokenBin | undefined;
  let seen = 0;
  let binEnd = Math.floor(total / binCount);
  for (const [sequence, values] of sequences.entries()) {
    for (let token = 0; token < values.length; token++) {
      const value = values[token] ?? 0;
      if (!current) {
        current = { count: 0, peak: value, sequence, token };
      } else if (Math.abs(value) > Math.abs(current.peak)) {
        current.peak = value;
        current.sequence = sequence;
        current.token = token;
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

/** A value in three significant figures, switching to exponent notation
 *  for very large or small magnitudes. */
export const formatTokenValue = (value: number): string => {
  if (value === 0) return "0";
  const magnitude = Math.abs(value);
  if (magnitude >= 1e4 || magnitude < 1e-3) return value.toExponential(2);
  return String(Number(value.toPrecision(3)));
};
