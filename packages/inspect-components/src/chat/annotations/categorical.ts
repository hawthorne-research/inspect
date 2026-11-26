import type { CSSProperties } from "react";

import type { CategoricalField } from "./format";
import type { ResolvedLayer } from "./layers";

/** Opacity of an option's tint behind text, in percent: enough to tell the
 *  palette's hues apart, little enough that body text keeps its contrast in
 *  both themes. */
const kOptionTintPercent = 30;

/** Opacity of spans the legend's highlight leaves out. */
const kDimmedOpacity = 0.3;

const kPaletteSize = 8;

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
  /** Options 9 to 16 reuse the palette's hues, hatched. */
  hatched: boolean;
}

/** An option's tint, stable by its index in the field's options; undefined
 *  for the "no" of a yes/no field. Options past 16 share a neutral grey. */
const optionTint = (
  field: CategoricalField,
  option: string
): OptionTint | undefined => {
  const binary = binaryOptions(field);
  if (binary) {
    return option === binary.on
      ? { color: "var(--inspect-annotation-option-yes)", hatched: false }
      : undefined;
  }
  const index = field.options.indexOf(option);
  if (index < 0) return undefined;
  if (index >= 2 * kPaletteSize) {
    return { color: "var(--inspect-annotation-option-none)", hatched: false };
  }
  return {
    color: `var(--inspect-annotation-option-${(index % kPaletteSize) + 1})`,
    hatched: index >= kPaletteSize,
  };
};

const mix = (color: string, percent: number): string =>
  `color-mix(in srgb, ${color} ${percent}%, transparent)`;

/** Hatched tints alternate the tint with a weaker stripe. */
const tintBackground = ({ color, hatched }: OptionTint): CSSProperties => {
  const solid = mix(color, kOptionTintPercent);
  return hatched
    ? {
        backgroundImage: `repeating-linear-gradient(135deg, ${solid} 0 4px, ${mix(color, kOptionTintPercent / 3)} 4px 7px)`,
      }
    : { backgroundColor: solid };
};

// Shared per tint, so React's style diff is a no-op for spans whose colour
// didn't change.
const kStyles = new Map<string, CSSProperties>();

/**
 * A span's style for its option of `field`: the option's tint, faded when
 * `highlighted` leaves the option out. Undefined when there is neither.
 */
export const optionStyle = (
  field: CategoricalField,
  option: string | undefined,
  highlighted: readonly string[]
): CSSProperties | undefined => {
  const tint = option === undefined ? undefined : optionTint(field, option);
  const dimmed = isDimmed(highlighted, option);
  if (!tint && !dimmed) return undefined;
  const key = `${tint?.color}|${tint?.hatched}|${dimmed}`;
  const cached = kStyles.get(key);
  if (cached) return cached;
  const style: CSSProperties = {
    ...(tint ? tintBackground(tint) : {}),
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
