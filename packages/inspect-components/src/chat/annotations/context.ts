import { createContext, useContext } from "react";

import type { AnnotationField } from "./format";
import type { ResolvedLayer } from "./layers";

/** The annotation layer on screen and how the legend draws it. */
export interface AnnotationView {
  layer: ResolvedLayer;
  /** The field that colours the spans; its type picks the rendering. */
  field: AnnotationField;
  /** The magnitude drawn at full colour for a numeric `field`; 0 for a
   *  categorical one. */
  scale: number;
  /** Options of a categorical `field` kept at full strength; empty keeps
   *  all. */
  highlighted: readonly string[];
}

export const AnnotationsContext = createContext<AnnotationView | undefined>(
  undefined
);

export const useAnnotationView = (): AnnotationView | undefined =>
  useContext(AnnotationsContext);
