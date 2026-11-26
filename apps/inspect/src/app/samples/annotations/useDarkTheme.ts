import { useSyncExternalStore } from "react";

// The theme bootstrap writes the resolved theme to <html data-bs-theme>,
// including OS and VS Code theme changes, so that attribute is the one
// signal to follow.
const subscribe = (onChange: () => void): (() => void) => {
  if (typeof MutationObserver === "undefined") return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-bs-theme"],
  });
  return () => observer.disconnect();
};

const isDark = (): boolean =>
  document.documentElement.getAttribute("data-bs-theme") === "dark";

/** Whether the page is in its dark theme, updating when the theme changes:
 *  annotation colours pick their text colour against the page. */
export const useDarkTheme = (): boolean =>
  useSyncExternalStore(subscribe, isDark, () => false);
