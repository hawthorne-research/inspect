import type { CategoricalField } from "./format";
import type { ResolvedLayer } from "./layers";
import {
  paletteColors,
  textOn,
  withAlpha,
  type Palette,
  type SpanStyle,
} from "./schemes";

/** Opacity of spans the legend's highlight leaves out. */
const kDimmedOpacity = 0.3;

/** Whether `option` of `field` means "nothing found". */
export const isNegative = (field: CategoricalField, option: string): boolean =>
  field.negative.includes(option);

/** An option's colour in a palette. */
export interface OptionColor {
  /** A hex hue. */
  color: string;
  /** Options past the palette's length reuse its hues, hatched. */
  hatched: boolean;
}

/**
 * The colour of `option` of `field` in `palette`: the palette's hue at the
 * option's position among the field's non-negative options, so the first
 * of them always gets the first hue. Past the palette's length the hues
 * repeat hatched, and past twice its length options share a neutral grey.
 * Undefined for a negative option, which is never tinted, and for one the
 * field doesn't have.
 */
export const optionColor = (
  field: CategoricalField,
  option: string,
  palette: Palette
): OptionColor | undefined => {
  if (isNegative(field, option)) return undefined;
  const index = field.options
    .filter((o) => !isNegative(field, o))
    .indexOf(option);
  if (index < 0) return undefined;
  const colors = paletteColors(palette);
  const size = colors.options.length;
  const color = colors.options[index % size];
  if (index >= 2 * size || color === undefined) {
    return { color: colors.none, hatched: false };
  }
  return { color, hatched: index >= size };
};

/** The tint behind the text, with black or white text on it; hatched tints
 *  alternate the tint with a weaker stripe. */
const tintStyle = (
  { color, hatched }: OptionColor,
  { scheme, dark }: Palette
): SpanStyle => {
  const solid = withAlpha(color, scheme.tint);
  return {
    color: textOn(color, scheme.tint, dark),
    ...(hatched
      ? {
          backgroundImage: `repeating-linear-gradient(135deg, ${solid} 0 4px, ${withAlpha(color, scheme.tint / 3)} 4px 7px)`,
        }
      : { backgroundColor: solid }),
  };
};

// Shared per tint, so React's style diff is a no-op for spans whose colour
// didn't change.
const kStyles = new Map<string, SpanStyle>();

/**
 * A span's style for its option of `field` in `palette`: the option's tint
 * with readable text, faded when `highlighted` leaves the option out.
 * Undefined when there is neither.
 */
export const optionStyle = (
  field: CategoricalField,
  option: string | undefined,
  highlighted: readonly string[],
  palette: Palette
): SpanStyle | undefined => {
  const tint =
    option === undefined ? undefined : optionColor(field, option, palette);
  const dimmed = isDimmed(highlighted, option);
  if (!tint && !dimmed) return undefined;
  const key = `${palette.scheme.id}|${palette.dark}|${tint?.color}|${tint?.hatched}|${dimmed}`;
  const cached = kStyles.get(key);
  if (cached) return cached;
  const style: SpanStyle = {
    ...(tint ? tintStyle(tint, palette) : {}),
    ...(dimmed ? { opacity: kDimmedOpacity } : {}),
  };
  kStyles.set(key, style);
  return style;
};

/** How many spans of `layer` carry each option of `field` (options in
 *  field order, including zero counts). */
export const countOptions = (
  layer: ResolvedLayer,
  field: CategoricalField
): Array<{ option: string; count: number }> => {
  const counts = new Map(field.options.map((option) => [option, 0]));
  for (const part of layer.parts) {
    for (const label of part.labels.get(field.name) ?? []) {
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  return field.options.map((option) => ({
    option,
    count: counts.get(option) ?? 0,
  }));
};

/** Whether a span is dimmed by the legend's highlight: only when some
 *  options are highlighted and its label is not one of them. */
const isDimmed = (
  highlighted: readonly string[],
  label: string | undefined
): boolean =>
  highlighted.length > 0 &&
  (label === undefined || !highlighted.includes(label));

/**
 * The option that stands for several spans' `labels`: the most frequent
 * (the earlier option on ties), passing over negative options unless
 * nothing else is there. When some of the highlighted options are there,
 * only they count, so a highlight still finds a rare option.
 */
export const summaryOption = (
  field: CategoricalField,
  labels: readonly (string | undefined)[],
  highlighted: readonly string[]
): string | undefined => {
  const counts = new Map<string, number>();
  for (const label of labels) {
    if (label !== undefined) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const present = field.options.filter((option) => counts.has(option));
  const shown = present.filter((option) => highlighted.includes(option));
  const found = present.filter((option) => !isNegative(field, option));
  const candidates =
    shown.length > 0 ? shown : found.length > 0 ? found : present;
  let best: string | undefined;
  for (const option of candidates) {
    if (
      best === undefined ||
      (counts.get(option) ?? 0) > (counts.get(best) ?? 0)
    ) {
      best = option;
    }
  }
  return best;
};
