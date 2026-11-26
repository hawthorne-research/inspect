/** The colours of one theme (light or dark) in a colour scheme, as hex. */
export interface SchemeColors {
  /** Categorical options' hues, by option index. */
  options: readonly string[];
  /** The "yes" (or "1") of a yes/no field. */
  yes: string;
  /** Options past twice the palette's length. */
  none: string;
  /** Numeric values below and above zero. */
  negative: string;
  positive: string;
}

/** A set of colours for annotated spans, cycled from the legend. */
export interface ColorScheme {
  id: string;
  name: string;
  light: SchemeColors;
  dark: SchemeColors;
  /** Opacity of a categorical option's tint, 0 to 1. */
  tint: number;
  /** Opacity of a numeric value's shade at full intensity, 0 to 1. */
  maxShade: number;
}

/** A scheme in a theme: everything a span's colour depends on besides its
 *  value. */
export interface Palette {
  scheme: ColorScheme;
  dark: boolean;
}

const same = (colors: SchemeColors) => ({ light: colors, dark: colors });

// Okabe & Ito's colour-blind-safe palette, with grey in place of black,
// which would hide text.
const kOkabeIto: SchemeColors = {
  options: [
    "#0072b2",
    "#e69f00",
    "#009e73",
    "#cc79a7",
    "#56b4e9",
    "#d55e00",
    "#f0e442",
    "#999999",
  ],
  yes: "#d55e00",
  none: "#999999",
  negative: "#0072b2",
  positive: "#d55e00",
};

/** The schemes, in the order the legend cycles through them. */
export const kColorSchemes: readonly ColorScheme[] = [
  {
    id: "default",
    name: "Default",
    light: {
      options: [
        "#2a78d6",
        "#eb6834",
        "#1baf7a",
        "#eda100",
        "#e87ba4",
        "#008300",
        "#6250d6",
        "#e34948",
      ],
      yes: "#eb6834",
      none: "#a9abaf",
      negative: "#257de0",
      positive: "#ec4647",
    },
    dark: {
      options: [
        "#3987e5",
        "#d95926",
        "#199e70",
        "#c98500",
        "#d55181",
        "#008300",
        "#9085e9",
        "#e66767",
      ],
      yes: "#d95926",
      none: "#67696f",
      negative: "#1b64be",
      positive: "#c0392b",
    },
    tint: 0.3,
    maxShade: 0.8,
  },
  {
    id: "okabe-ito",
    name: "Okabe–Ito (colour-blind safe)",
    ...same(kOkabeIto),
    tint: 0.35,
    maxShade: 0.8,
  },
  {
    id: "tol-bright",
    name: "Tol bright (colour-blind safe)",
    // Paul Tol's "bright" qualitative palette; his "sunset" diverging
    // scheme's ends for numbers.
    ...same({
      options: [
        "#4477aa",
        "#ee6677",
        "#228833",
        "#ccbb44",
        "#66ccee",
        "#aa3377",
        "#bbbbbb",
        "#555555",
      ],
      yes: "#ee6677",
      none: "#bbbbbb",
      negative: "#364b9a",
      positive: "#a50026",
    }),
    tint: 0.35,
    maxShade: 0.85,
  },
  {
    id: "high-contrast",
    name: "High contrast",
    ...same(kOkabeIto),
    tint: 0.9,
    maxShade: 1,
  },
  {
    id: "high-contrast-saturated",
    name: "High contrast, saturated",
    ...same({
      options: [
        "#0000ff",
        "#ff0000",
        "#00a000",
        "#ffd700",
        "#ff00ff",
        "#00c8ff",
        "#ff8c00",
        "#7f00ff",
      ],
      yes: "#ff0000",
      none: "#808080",
      negative: "#0000ff",
      positive: "#ff0000",
    }),
    tint: 1,
    maxShade: 1,
  },
];

const kSchemeDefault: ColorScheme = kColorSchemes[0] ?? {
  id: "none",
  name: "None",
  ...same({ options: [], yes: "", none: "", negative: "", positive: "" }),
  tint: 0,
  maxShade: 0,
};

/** The scheme with `id`, or the first when there's none. */
export const colorScheme = (id: string | undefined): ColorScheme =>
  kColorSchemes.find((scheme) => scheme.id === id) ?? kSchemeDefault;

/** The scheme `step` places after `scheme` in `kColorSchemes` (before it
 *  when negative), wrapping round. */
export const stepColorScheme = (
  scheme: ColorScheme,
  step: number
): ColorScheme => {
  const count = kColorSchemes.length;
  const index =
    (((kColorSchemes.indexOf(scheme) + step) % count) + count) % count;
  return kColorSchemes[index] ?? kSchemeDefault;
};

/** The palette's colours for its theme. */
export const paletteColors = ({ scheme, dark }: Palette): SchemeColors =>
  dark ? scheme.dark : scheme.light;

/** `color` at `alpha` (0 to 1), as CSS. */
export const withAlpha = (color: string, alpha: number): string => {
  const [r, g, b] = rgb(color);
  return `rgba(${r}, ${g}, ${b}, ${Number(alpha.toFixed(3))})`;
};

// Bootstrap's page backgrounds, which tints are drawn over.
const kPageLight = "#ffffff";
const kPageDark = "#212529";

/**
 * Black or white, whichever has the higher APCA contrast (Lc) with `color`
 * drawn at `alpha` over the theme's page background. APCA, the contrast
 * measure in the WCAG 3 draft, follows perception better than WCAG 2's
 * ratio, which prefers black on saturated mid-tones such as pure red where
 * white reads better. Spans sit on slightly tinted message panels, so the
 * background is a close estimate.
 */
export const textOn = (color: string, alpha: number, dark: boolean): string => {
  const shown = blend(rgb(color), rgb(dark ? kPageDark : kPageLight), alpha);
  const background = screenLuminance(shown);
  return apcaContrast(1, background) > apcaContrast(0, background)
    ? "#ffffff"
    : "#000000";
};

type Rgb = readonly [number, number, number];

const rgb = (hex: string): Rgb => {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const blend = (top: Rgb, bottom: Rgb, alpha: number): Rgb => [
  top[0] * alpha + bottom[0] * (1 - alpha),
  top[1] * alpha + bottom[1] * (1 - alpha),
  top[2] * alpha + bottom[2] * (1 - alpha),
];

/** APCA's screen luminance of an sRGB colour (a plain 2.4 power curve). */
const screenLuminance = ([r, g, b]: Rgb): number =>
  0.2126729 * (r / 255) ** 2.4 +
  0.7151522 * (g / 255) ** 2.4 +
  0.072175 * (b / 255) ** 2.4;

// APCA-W3 0.0.98G constants.
const kBlackThreshold = 0.022;
const kBlackClamp = 1.414;
const kScale = 1.14;
const kOffset = 0.027;
const kLowClip = 0.1;

const softClampBlack = (y: number): number =>
  y > kBlackThreshold ? y : y + (kBlackThreshold - y) ** kBlackClamp;

/** The magnitude of APCA's lightness contrast Lc (0 to about 108) of text
 *  of luminance `text` on a background of luminance `background`. */
export const apcaContrast = (text: number, background: number): number => {
  const t = softClampBlack(text);
  const b = softClampBlack(background);
  if (Math.abs(b - t) < 0.0005) return 0;
  // Dark text on a light background, and light text on a dark one, follow
  // different curves.
  const sapc =
    b > t ? (b ** 0.56 - t ** 0.57) * kScale : (b ** 0.65 - t ** 0.62) * kScale;
  const magnitude = Math.abs(sapc);
  return magnitude < kLowClip ? 0 : (magnitude - kOffset) * 100;
};
