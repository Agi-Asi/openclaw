import { afterEach, describe, expect, it } from "vitest";
import { createOverflowFadeRef } from "./overflow-fade.ts";

function buildTitle(params: { textWidth: number; titleWidth: number; direction?: "ltr" | "rtl" }) {
  const title = document.createElement("span");
  title.className = "sidebar-recent-session__name";
  title.style.direction = params.direction ?? "ltr";
  const content = document.createElement("span");
  content.className = "sidebar-recent-session__name-content";
  content.textContent = "Fix stale iMessage group-allowlist warning copy";
  title.append(content);
  document.body.append(title);
  Object.defineProperty(title, "clientWidth", { value: params.titleWidth });
  Object.defineProperty(content, "scrollWidth", { value: params.textWidth });
  return title;
}

describe("overflow fade", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("marks only genuinely clipped titles for a resting fade", () => {
    const clipped = buildTitle({ textWidth: 320, titleWidth: 180 });
    createOverflowFadeRef()(clipped);
    expect(clipped.hasAttribute("data-overflow-fade")).toBe(true);

    const fitting = buildTitle({ textWidth: 120, titleWidth: 180 });
    createOverflowFadeRef()(fitting);
    expect(fitting.hasAttribute("data-overflow-fade")).toBe(false);
  });

  it("reveals only the hidden tail", () => {
    const title = buildTitle({ textWidth: 320, titleWidth: 180 });
    createOverflowFadeRef()(title);

    expect(title.style.getPropertyValue("--overflow-reveal-translate")).toBe("-140px");
    expect(title.style.getPropertyValue("--overflow-reveal-duration")).toBe("2240ms");
  });

  it("leaves fitting titles untouched", () => {
    const title = buildTitle({ textWidth: 120, titleWidth: 180 });
    createOverflowFadeRef()(title);
    expect(title.style.getPropertyValue("--overflow-reveal-translate")).toBe("");
  });

  it("bounds reveal duration and reverses travel for RTL", () => {
    const short = buildTitle({ textWidth: 190, titleWidth: 180 });
    createOverflowFadeRef()(short);
    expect(short.style.getPropertyValue("--overflow-reveal-duration")).toBe("1200ms");

    const long = buildTitle({ textWidth: 900, titleWidth: 180, direction: "rtl" });
    createOverflowFadeRef()(long);
    expect(long.style.getPropertyValue("--overflow-reveal-translate")).toBe("720px");
    expect(long.style.getPropertyValue("--overflow-reveal-duration")).toBe("8000ms");
  });

  it("ignores detached refs", () => {
    expect(() => createOverflowFadeRef()(undefined)).not.toThrow();
  });
});
