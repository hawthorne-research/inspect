import { useState } from "react";

import { useEventListener } from "@tsmono/react/hooks";

import { hoveredSpan, type HoveredSpan } from "./dom";
import type { ResolvedSet } from "./model";

/**
 * The span of `set` under the pointer in the messages, or null. Listens on
 * the document rather than on each of the sample's spans, and forgets the
 * span on scroll, which moves it from under the pointer.
 */
export const useHoveredSpan = (set: ResolvedSet): HoveredSpan | null => {
  const [hover, setHover] = useState<HoveredSpan | null>(null);
  useEventListener(document, "mouseover", (e) => {
    setHover(hoveredSpan(e, set));
  });
  // No mouseover follows when the pointer leaves the window.
  useEventListener(document, "mouseout", (e) => {
    if (!e.relatedTarget) setHover(null);
  });
  useEventListener(document, "scroll", () => setHover(null), {
    capture: true,
    passive: true,
  });
  return hover;
};
