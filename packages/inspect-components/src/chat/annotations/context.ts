import { createContext, useContext } from "react";

import type { AnnotationView } from "./model";

export const AnnotationsContext = createContext<AnnotationView | undefined>(
  undefined
);

export const useAnnotationView = (): AnnotationView | undefined =>
  useContext(AnnotationsContext);
