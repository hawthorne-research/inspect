import type { LoadedTokenValues, TokenPart } from "./tokenValues";

// Tokens are found by attribute, not per-token handlers: a sample can hold
// tens of thousands of them.
export const kPartAttribute = "data-token-part";
export const kTokenAttribute = "data-token-index";

/** Selects token `token` of the part rendered with index `part`. */
export const tokenSelector = (part: number, token: number): string =>
  `[${kPartAttribute}="${part}"] [${kTokenAttribute}="${token}"]`;

export interface HoveredToken {
  part: TokenPart;
  token: number;
  rect: DOMRect;
}

/** The token under an event target, if the target is a rendered token of
 *  `values`. */
export const hoveredToken = (
  target: EventTarget | null,
  values: LoadedTokenValues
): HoveredToken | null => {
  if (!(target instanceof Element)) return null;
  const tokenEl = target.closest(`[${kTokenAttribute}]`);
  const partEl = tokenEl?.closest(`[${kPartAttribute}]`);
  if (!tokenEl || !partEl) return null;
  const part = values.parts[Number(partEl.getAttribute(kPartAttribute))];
  const token = Number(tokenEl.getAttribute(kTokenAttribute));
  if (!part || !Number.isInteger(token) || token >= part.starts.length) {
    return null;
  }
  return { part, token, rect: tokenEl.getBoundingClientRect() };
};

/** Rings a token briefly after the overview strip scrolled to it. */
export const flashToken = (element: Element): void => {
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
