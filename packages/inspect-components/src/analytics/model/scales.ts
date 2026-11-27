/** The low and high ends of an axis. */
export type Domain = readonly [number, number];

/** About this many ticks on an axis, as d3's default. */
const kTickCount = 5;

/**
 * d3's `tickIncrement`: a tick step of 1, 2 or 5 times a power of ten
 * giving about `count` ticks over [lo, hi]. A step below 1 comes back as
 * its negated inverse (-10 for 0.1), so callers multiply by whole numbers
 * rather than divide by fractions, which keeps 0.9 / 0.1 from rounding up
 * past 9.
 */
const tickIncrement = (lo: number, hi: number, count: number): number => {
  const step = (hi - lo) / count;
  const power = Math.floor(Math.log10(step));
  const error = step / 10 ** power;
  const factor =
    error >= Math.sqrt(50)
      ? 10
      : error >= Math.sqrt(10)
        ? 5
        : error >= Math.sqrt(2)
          ? 2
          : 1;
  return power >= 0 ? factor * 10 ** power : -(10 ** -power) / factor;
};

/**
 * `domain` widened to whole tick steps, as d3's `scale.nice()`. A domain of
 * one value first widens around it, by half its magnitude each way or by
 * 0.5 when that is more.
 */
export const niceDomain = (domain: Domain, count = kTickCount): Domain => {
  let [lo, hi] = domain;
  if (lo === hi) {
    const pad = Math.max(0.5, Math.abs(lo) / 2);
    lo -= pad;
    hi += pad;
  }
  let previous: number | undefined;
  // Widening can change the step, so repeat until it settles, as d3 does.
  for (let i = 0; i < 10; i++) {
    const step = tickIncrement(lo, hi, count);
    if (step === previous || !Number.isFinite(step) || step === 0) break;
    if (step > 0) {
      lo = Math.floor(lo / step) * step;
      hi = Math.ceil(hi / step) * step;
    } else {
      lo = Math.ceil(lo * step) / step;
      hi = Math.floor(hi * step) / step;
    }
    previous = step;
  }
  // + 0 turns -0 into 0.
  return [lo + 0, hi + 0];
};

/** About `count` evenly spaced round values within `domain`, as d3's
 *  `ticks`. */
export const ticks = ([lo, hi]: Domain, count = kTickCount): number[] => {
  if (!(hi > lo)) return [lo];
  const increment = tickIncrement(lo, hi, count);
  const inverse = increment < 0;
  const factor = Math.abs(increment);
  const toIndex = (value: number) =>
    inverse ? value * factor : value / factor;
  const fromIndex = (index: number) =>
    (inverse ? index / factor : index * factor) + 0;
  let first = Math.round(toIndex(lo));
  let last = Math.round(toIndex(hi));
  if (fromIndex(first) < lo) first += 1;
  if (fromIndex(last) > hi) last -= 1;
  return Array.from({ length: Math.max(0, last - first + 1) }, (_, i) =>
    fromIndex(first + i)
  );
};

/** Takes a value on one axis to where it is on another, so one plot can
 *  draw several axes' values against a single scale. */
export type LinearMap = (value: number) => number;

/** The linear map taking `from`'s ends to `to`'s. */
export const linearMap = (from: Domain, to: Domain): LinearMap => {
  const [a0, a1] = from;
  const [b0, b1] = to;
  const scale = (b1 - b0) / (a1 - a0);
  return (value) => b0 + (value - a0) * scale;
};
