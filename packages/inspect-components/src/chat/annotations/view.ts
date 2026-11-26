import type { CSSProperties } from "react";

import { optionStyle } from "./categorical";
import type { AnnotationField } from "./format";
import type { ResolvedLayer, ResolvedPart } from "./layers";
import { fieldScale, formatValue, valueStyle } from "./numeric";
import type { Palette } from "./schemes";

/** The annotation layer on screen and the field that colours its spans. */
export interface AnnotationView {
  layer: ResolvedLayer;
  field: AnnotationField;
  /** Options of a categorical `field` kept at full strength; empty keeps
   *  all. */
  highlighted: readonly string[];
  /** The magnitude drawn at full colour for a numeric `field`; 0 for a
   *  categorical one. */
  scale: number;
  /** The colour scheme and theme the spans are drawn in. */
  palette: Palette;
}

const kNone: readonly string[] = [];

/** The view of `field` of `layer`, keeping the `highlight`ed options the
 *  field has. */
export const annotationView = (
  layer: ResolvedLayer,
  field: AnnotationField,
  highlight: readonly string[],
  palette: Palette
): AnnotationView => {
  if (field.type === "numeric") {
    return {
      layer,
      field,
      highlighted: kNone,
      scale: fieldScale(layer, field),
      palette,
    };
  }
  const highlighted = highlight.filter((o) => field.options.includes(o));
  return {
    layer,
    field,
    highlighted: highlighted.length > 0 ? highlighted : kNone,
    scale: 0,
    palette,
  };
};

/** The background of span `span` of `part` for the view's field. */
export const spanStyle = (
  view: AnnotationView,
  part: ResolvedPart,
  span: number
): CSSProperties | undefined => {
  const { field } = view;
  return field.type === "categorical"
    ? optionStyle(
        field,
        part.labels.get(field.name)?.[span],
        view.highlighted,
        view.palette
      )
    : valueStyle(
        part.values.get(field.name)?.[span] ?? 0,
        view.scale,
        view.palette
      );
};

export interface OptionProbability {
  option: string;
  probability: number;
  /** The option is the span's value. */
  chosen: boolean;
}

/** A span's value of one field. */
export interface SpanValue {
  text: string;
  /** The value of a numeric field; undefined for a categorical one. */
  number: number | undefined;
  /** Each option's probability, most likely first; empty when the layer
   *  has none for the field. */
  probabilities: readonly OptionProbability[];
}

/** The value of `field` on span `span` of `part`. */
export const spanValue = (
  field: AnnotationField,
  part: ResolvedPart,
  span: number
): SpanValue => {
  if (field.type === "numeric") {
    const value = part.values.get(field.name)?.[span];
    return {
      text: value === undefined ? "—" : formatValue(value),
      number: value,
      probabilities: [],
    };
  }
  const label = part.labels.get(field.name)?.[span];
  const distribution = part.probabilities.get(field.name)?.[span] ?? [];
  return {
    text: label ?? "—",
    number: undefined,
    probabilities: distribution
      .map((probability, i) => {
        const option = field.options[i] ?? "";
        return { option, probability, chosen: option === label };
      })
      .sort((a, b) => b.probability - a.probability),
  };
};
