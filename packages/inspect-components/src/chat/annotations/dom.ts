import type { AnnotationField } from "./format";
import type { ResolvedLayer, ResolvedPart } from "./layers";
import type { SpanLocation } from "./strip";

// Spans are found by attribute, not per-span handlers: a sample can hold
// tens of thousands of them.
export const kPartAttribute = "data-annotation-part";
export const kSpanAttribute = "data-annotation-span";

/** Selects a rendered span of the active layer. */
export const spanSelector = ({ part, span }: SpanLocation): string =>
  `[${kPartAttribute}="${part}"] [${kSpanAttribute}="${span}"]`;

export interface HoveredSpan {
  part: ResolvedPart;
  span: number;
  rect: DOMRect;
}

/** The span under an event target, if the target is a rendered span of
 *  `layer`. */
export const hoveredSpan = (
  target: EventTarget | null,
  layer: ResolvedLayer
): HoveredSpan | null => {
  if (!(target instanceof Element)) return null;
  const spanEl = target.closest(`[${kSpanAttribute}]`);
  const partEl = spanEl?.closest(`[${kPartAttribute}]`);
  if (!spanEl || !partEl) return null;
  const part = layer.parts[Number(partEl.getAttribute(kPartAttribute))];
  const span = Number(spanEl.getAttribute(kSpanAttribute));
  if (!part || !Number.isInteger(span) || span >= part.starts.length) {
    return null;
  }
  return { part, span, rect: spanEl.getBoundingClientRect() };
};

/** Rings a span briefly after the strip scrolled to it. A labelled
 *  paragraph also gets a tint; a shaded span keeps its own background. */
export const flashSpan = (
  element: Element,
  rendering: AnnotationField["type"]
): void => {
  const ring = "0 0 0 2px var(--bs-primary)";
  const clear = "0 0 0 2px transparent";
  const tint = "rgba(var(--bs-primary-rgb), 0.1)";
  const keyframes: Keyframe[] =
    rendering === "categorical"
      ? [
          { boxShadow: ring, backgroundColor: tint },
          { boxShadow: ring, backgroundColor: tint, offset: 0.45 },
          { boxShadow: clear, backgroundColor: "transparent" },
        ]
      : [
          { boxShadow: ring },
          { boxShadow: ring, offset: 0.5 },
          { boxShadow: clear },
        ];
  element.animate(keyframes, { duration: 1800, easing: "ease-out" });
};
