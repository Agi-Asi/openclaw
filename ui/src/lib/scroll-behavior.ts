// Shared imperative-scroll behavior resolver for the Control UI.
// The global `prefers-reduced-motion` CSS rule cannot override `ScrollOptions`
// passed directly to `scrollIntoView`/`scrollTo`, so every imperative smooth
// scroll must resolve its behavior through this helper to honor the user's
// reduced-motion preference.

/**
 * Resolves the requested `ScrollBehavior`, downgrading it to `auto` when the
 * user prefers reduced motion. Non-animated behaviors pass through unchanged,
 * and environments without `window.matchMedia` (SSR/tests) keep the request.
 */
export function resolveScrollBehavior(behavior: ScrollBehavior = "smooth"): ScrollBehavior {
  if (behavior === "auto" || behavior === "instant") {
    return behavior;
  }
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return behavior;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : behavior;
}
