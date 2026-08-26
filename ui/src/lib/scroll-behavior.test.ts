// Control UI tests cover the shared reduced-motion-aware scroll behavior resolver.
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveScrollBehavior } from "./scroll-behavior.ts";

// jsdom does not implement window.matchMedia, so each test installs a
// controllable stub and removes it afterwards to keep behavior observable.
function stubMatchMedia(reduced: boolean): ReturnType<typeof vi.fn> {
  const matchMedia = vi.fn().mockReturnValue({ matches: reduced });
  vi.stubGlobal("matchMedia", matchMedia);
  return matchMedia;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveScrollBehavior", () => {
  it("downgrades smooth scrolling to auto under prefers-reduced-motion: reduce", () => {
    stubMatchMedia(true);
    expect(resolveScrollBehavior()).toBe("auto");
    expect(resolveScrollBehavior("smooth")).toBe("auto");
  });

  it("keeps smooth scrolling when reduced motion is not requested", () => {
    const matchMedia = stubMatchMedia(false);
    expect(resolveScrollBehavior()).toBe("smooth");
    expect(resolveScrollBehavior("smooth")).toBe("smooth");
    expect(matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
  });

  it("keeps the requested behavior when matchMedia is unavailable", () => {
    // Node/SSR-style environments may lack window.matchMedia entirely.
    vi.stubGlobal("matchMedia", undefined);
    expect(resolveScrollBehavior()).toBe("smooth");
    expect(resolveScrollBehavior("smooth")).toBe("smooth");
  });

  it("preserves non-animated behaviors without consulting the media query", () => {
    const matchMedia = stubMatchMedia(true);
    expect(resolveScrollBehavior("auto")).toBe("auto");
    expect(resolveScrollBehavior("instant")).toBe("instant");
    expect(matchMedia).not.toHaveBeenCalled();
  });
});
