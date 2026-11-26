import { describe, expect, it } from "vitest";

import {
  binTokens,
  formatTokenValue,
  quantile,
  tokenIntensity,
  tokenScale,
  tokenStyle,
} from "./tokenScale";

describe("tokenScale", () => {
  it("is the 99th percentile of |value| across every part", () => {
    // |values| 0..100 in two parts: the 99th percentile of 101 evenly
    // spaced values is 99.
    const values = Array.from({ length: 101 }, (_, i) =>
      i % 2 === 0 ? i : -i
    );
    expect(tokenScale([values.slice(0, 40), values.slice(40)])).toBeCloseTo(99);
  });

  it("ignores a few outliers", () => {
    const values = [...Array.from({ length: 1000 }, () => 1), 500, -800];
    expect(tokenScale([values])).toBe(1);
  });

  it("interpolates between order statistics", () => {
    expect(quantile(new Float64Array([0, 10]), 0.99)).toBeCloseTo(9.9);
  });

  it("is 0 for all-zero values and for no tokens", () => {
    expect(tokenScale([[0, 0], [0]])).toBe(0);
    expect(tokenScale([])).toBe(0);
  });
});

describe("token colour", () => {
  it("is proportional to value over scale, signed", () => {
    expect(tokenIntensity(1, 4)).toBe(0.25);
    expect(tokenIntensity(-2, 4)).toBe(-0.5);
  });

  it("clips values beyond the scale to full intensity", () => {
    expect(tokenIntensity(40, 4)).toBe(1);
    expect(tokenIntensity(-40, 4)).toBe(-1);
  });

  it("colours nothing when the scale is 0", () => {
    expect(tokenIntensity(5, 0)).toBe(0);
    expect(tokenStyle(5, 0)).toBeUndefined();
  });

  it("leaves zero uncoloured", () => {
    expect(tokenStyle(0, 4)).toBeUndefined();
  });

  it("uses the sign's hue at an opacity up to 80%", () => {
    expect(tokenStyle(2, 4)?.backgroundColor).toBe(
      "color-mix(in srgb, var(--inspect-token-value-positive) 40%, transparent)"
    );
    expect(tokenStyle(-100, 4)?.backgroundColor).toBe(
      "color-mix(in srgb, var(--inspect-token-value-negative) 80%, transparent)"
    );
  });

  it("gives equal magnitudes equal opacity on both sides", () => {
    const opacity = (value: number) =>
      tokenStyle(value, 3)?.backgroundColor?.match(/(\d+)%/)?.[1];
    expect(opacity(1)).toBe(opacity(-1));
  });
});

describe("binTokens", () => {
  it("cuts tokens into bins of equal count across parts", () => {
    const sequences = [Array.from({ length: 7 }, () => 0), [0, 0, 0]];
    const bins = binTokens(sequences, 4);
    expect(bins).toHaveLength(4);
    const counts = bins.map((b) => b.count);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(10);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  it("reports each bin's value of largest magnitude and where it is", () => {
    const bins = binTokens(
      [
        [0.1, -3, 2],
        [1, 0.5, 4],
      ],
      2
    );
    expect(bins.map((b) => [b.peak, b.sequence, b.token])).toEqual([
      [-3, 0, 1],
      [4, 1, 2],
    ]);
  });

  it("keeps the first of equal peaks", () => {
    const [bin] = binTokens([[2, -2]], 1);
    expect(bin?.peak).toBe(2);
  });

  it("gives one bin per token when there are fewer tokens than bins", () => {
    const bins = binTokens([[1], [2, 3]], 300);
    expect(bins.map((b) => [b.count, b.peak])).toEqual([
      [1, 1],
      [1, 2],
      [1, 3],
    ]);
  });

  it("is empty without tokens", () => {
    expect(binTokens([[], []])).toEqual([]);
  });
});

describe("formatTokenValue", () => {
  it("shows three significant figures", () => {
    expect(formatTokenValue(1.23456)).toBe("1.23");
    expect(formatTokenValue(-0.012345)).toBe("-0.0123");
    expect(formatTokenValue(1234.5)).toBe("1230");
    expect(formatTokenValue(0)).toBe("0");
  });

  it("switches to exponents for extreme magnitudes", () => {
    expect(formatTokenValue(123456)).toBe("1.23e+5");
    expect(formatTokenValue(0.0001234)).toBe("1.23e-4");
  });
});
