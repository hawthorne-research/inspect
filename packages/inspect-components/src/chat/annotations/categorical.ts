import type { CSSProperties } from "react";

import type { CategoricalField } from "./format";
import type { ResolvedLayer } from "./layers";
import {
  paletteColors,
  textOn,
  withAlpha,
  type Palette,
  type SchemeColors,
} from "./schemes";

/** Opacity of spans the legend's highlight leaves out. */
const kDimmedOpacity = 0.3;

/** The two options of a yes/no field, `["yes", "no"]` or `["1", "0"]` in
 *  either order: `on` gets a strong tint and `off` none. */
const binaryOptions = (
  field: CategoricalField
): { on: string; off: string } | undefined => {
  if (field.options.length !== 2) return undefined;
  for (const [on, off] of [
    ["yes", "no"],
    ["1", "0"],
  ] as const) {
    if (field.options.includes(on) && field.options.includes(off)) {
      return { on, off };
    }
  }
  return undefined;
};

interface OptionTint {
  color: string;
  /** Options past the palette's length reuse its hues, hatched. */
  hatched: boolean;
}

/** An option's tint, stable by its index in the field's options; undefined
 *  for the "no" of a yes/no field. Options past twice the palette's length
 *  share a neutral grey. */
const optionTint = (
  field: CategoricalField,
  option: string,
  colors: SchemeColors
): OptionTint | undefined => {
  const binary = binaryOptions(field);
  if (binary) {
    return option === binary.on
      ? { color: colors.yes, hatched: false }
      : undefined;
  }
  const index = field.options.indexOf(option);
  const size = colors.options.length;
  if (index < 0) return undefined;
  const color = colors.options[index % size];
  if (index >= 2 * size || color === undefined) {
    return { color: colors.none, hatched: false };
  }
  return { color, hatched: index >= size };
};

/** The tint behind the text, with black or white text on it; hatched tints
 *  alternate the tint with a weaker stripe. */
const tintStyle = (
  { color, hatched }: OptionTint,
  { scheme, dark }: Palette
): CSSProperties => {
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
const kStyles = new Map<string, CSSProperties>();

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
): CSSProperties | undefined => {
  const tint =
    option === undefined
      ? undefined
      : optionTint(field, option, paletteColors(palette));
  const dimmed = isDimmed(highlighted, option);
  if (!tint && !dimmed) return undefined;
  const key = `${palette.scheme.id}|${palette.dark}|${tint?.color}|${tint?.hatched}|${dimmed}`;
  const cached = kStyles.get(key);
  if (cached) return cached;
  const style: CSSProperties = {
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
 * (the earlier option on ties), passing over the untinted "no"/"0" unless
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
  const untinted = binaryOptions(field)?.off;
  const shown = present.filter((option) => highlighted.includes(option));
  const tinted = present.filter((option) => option !== untinted);
  const candidates =
    shown.length > 0 ? shown : tinted.length > 0 ? tinted : present;
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
