import { describe, expect, it } from "vitest";

import {
  apcaContrast,
  colorScheme,
  kColorSchemes,
  stepColorScheme,
  textOn,
  withAlpha,
} from "./schemes";

describe("kColorSchemes", () => {
  it.each(kColorSchemes.map((s) => [s.id, s] as const))(
    "%s has eight hex hues and the other colours in both themes",
    (_, scheme) => {
      for (const colors of [scheme.light, scheme.dark]) {
        expect(colors.options).toHaveLength(8);
        for (const color of [
          ...colors.options,
          colors.none,
          colors.negative,
          colors.positive,
        ]) {
          expect(color).toMatch(/^#[0-9a-f]{6}$/);
        }
      }
      expect(scheme.tint).toBeGreaterThan(0);
      expect(scheme.maxShade).toBeLessThanOrEqual(1);
    }
  );

  it("includes high-contrast schemes with solid tints", () => {
    const solid = kColorSchemes.filter((s) => s.tint >= 0.9);
    expect(solid.map((s) => s.id)).toEqual([
      "high-contrast",
      "high-contrast-saturated",
    ]);
  });
});

describe("colorScheme and stepColorScheme", () => {
  it("falls back to the first scheme for an unknown id", () => {
    expect(colorScheme("nope")).toBe(kColorSchemes[0]);
    expect(colorScheme(undefined)).toBe(kColorSchemes[0]);
  });

  it("cycles forwards and back, wrapping round", () => {
    const first = colorScheme("default");
    const last = kColorSchemes[kColorSchemes.length - 1];
    expect(stepColorScheme(first, 1)).toBe(kColorSchemes[1]);
    expect(stepColorScheme(first, -1)).toBe(last);
    expect(last && stepColorScheme(last, 1)).toBe(first);
  });
});

describe("textOn", () => {
  it("picks white on dark backgrounds and black on light ones", () => {
    expect(textOn("#0000ff", 1, false)).toBe("#ffffff");
    expect(textOn("#ffd700", 1, true)).toBe("#000000");
  });

  it("picks white on saturated mid-tones such as pure red", () => {
    // WCAG 2's ratio would pick black here (5.3:1 against 4:1).
    expect(textOn("#ff0000", 1, false)).toBe("#ffffff");
    expect(textOn("#0072b2", 0.9, false)).toBe("#ffffff");
    expect(textOn("#e69f00", 0.9, false)).toBe("#000000");
  });

  it("accounts for the page behind a faint tint", () => {
    // A faint blue looks pale on white and dark on the dark theme's page.
    expect(textOn("#0000ff", 0.15, false)).toBe("#000000");
    expect(textOn("#0000ff", 0.15, true)).toBe("#ffffff");
  });
});

describe("withAlpha", () => {
  it("writes a hex colour as rgba", () => {
    expect(withAlpha("#2a78d6", 0.3)).toBe("rgba(42, 120, 214, 0.3)");
  });
});

describe("apcaContrast", () => {
  it("matches APCA's published values for black and white", () => {
    // APCA-W3 0.0.98G: black text on white is Lc 106, white on black Lc 108.
    expect(apcaContrast(0, 1)).toBeCloseTo(106.04, 1);
    expect(apcaContrast(1, 0)).toBeCloseTo(107.88, 1);
  });

  it("is zero for text the same as its background", () => {
    expect(apcaContrast(0.5, 0.5)).toBe(0);
  });
});
