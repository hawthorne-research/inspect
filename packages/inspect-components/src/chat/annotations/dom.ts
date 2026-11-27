import type { ResolvedLayer, ResolvedPart, SpanLocation } from "./model";

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
  /** The line of the span under the pointer: a span that wraps has one
   *  box per line. */
  rect: DOMRect;
}

/** The span under a mouse event's target, if the target is a rendered span
 *  of `layer`. */
export const hoveredSpan = (
  event: MouseEvent,
  layer: ResolvedLayer
): HoveredSpan | null => {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const spanEl = target.closest(`[${kSpanAttribute}]`);
  const partEl = spanEl?.closest(`[${kPartAttribute}]`);
  if (!spanEl || !partEl) return null;
  const part = layer.parts[Number(partEl.getAttribute(kPartAttribute))];
  const span = Number(spanEl.getAttribute(kSpanAttribute));
  if (!part || !Number.isInteger(span) || span >= part.starts.length) {
    return null;
  }
  const line = Array.from(spanEl.getClientRects()).find(
    (r) => event.clientY >= r.top && event.clientY <= r.bottom
  );
  return { part, span, rect: line ?? spanEl.getBoundingClientRect() };
};

/** Rings a span briefly after the strip scrolled to it. */
export const flashSpan = (element: Element): void => {
  const ring = "0 0 0 2px var(--bs-primary)";
  element.animate(
    [
      { boxShadow: ring },
      { boxShadow: ring, offset: 0.5 },
      { boxShadow: "0 0 0 2px transparent" },
    ],
    { duration: 1800, easing: "ease-out" }
  );
};
