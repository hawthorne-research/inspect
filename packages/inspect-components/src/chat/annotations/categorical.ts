import type { CategoricalField } from "./format";
import type { ResolvedLayer } from "./layers";

export const isYesNoField = (field: CategoricalField): boolean =>
  field.options.length === 2 &&
  field.options.includes("yes") &&
  field.options.includes("no");

const kPaletteSize = 8;

/** How an option is drawn: a palette colour, hollow (dashed border, ring
 *  swatch) for options past the palette's eight hues. */
export interface OptionMark {
  color: string;
  hollow: boolean;
}

/**
 * The mark for an option, stable by its index in the field's options.
 * Yes/no fields get a strong colour for "yes" and neutral grey for "no".
 * Options 9 and up reuse the palette's hues hollow rather than inventing
 * new hues.
 */
export const optionMark = (
  field: CategoricalField,
  option: string | undefined
): OptionMark => {
  const neutral = {
    color: "var(--inspect-annotation-option-none)",
    hollow: false,
  };
  if (option === undefined) return neutral;
  if (isYesNoField(field)) {
    return option === "yes"
      ? { color: "var(--inspect-annotation-option-yes)", hollow: false }
      : neutral;
  }
  const index = field.options.indexOf(option);
  if (index < 0 || index >= 2 * kPaletteSize) return neutral;
  return {
    color: `var(--inspect-annotation-option-${(index % kPaletteSize) + 1})`,
    hollow: index >= kPaletteSize,
  };
};

/** A bare "yes" or "no" says nothing on its own, so those labels carry
 *  their field's name. */
export const labelText = (field: CategoricalField, label: string): string =>
  label === "yes" || label === "no" ? `${field.name}: ${label}` : label;

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
export const isDimmed = (
  highlighted: readonly string[],
  label: string | undefined
): boolean =>
  highlighted.length > 0 &&
  (label === undefined || !highlighted.includes(label));
