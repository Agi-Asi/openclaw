import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../test/helpers/ui-style-fixtures.js";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const describeShimmer = canRunPlaywrightChromium(chromiumExecutablePath) ? describe : describe.skip;

let browser: Browser;

beforeAll(async () => {
  if (!canRunPlaywrightChromium(chromiumExecutablePath)) {
    return;
  }
  browser = await chromium.launch({ executablePath: chromiumExecutablePath, headless: true });
});

afterAll(async () => {
  await browser?.close().catch(() => {});
});

describeShimmer("Control UI shimmer", () => {
  it("moves loading highlights on compositor-safe pseudo-elements", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<!doctype html><html><head><style>
        ${readStyleSheet("ui/src/styles/base.css")}
        ${readStyleSheet("ui/src/styles/memory-import.css")}
        ${readStyleSheet("ui/src/styles/usage.css")}
      </style></head><body>
        <div class="skeleton skeleton-line"></div>
        <div class="skeleton usage-skeleton-block"></div>
        <div class="skeleton memory-import__skeleton"></div>
      </body></html>`);

      for (const selector of [
        ".skeleton-line",
        ".usage-skeleton-block",
        ".memory-import__skeleton",
      ]) {
        const styles = await page.locator(selector).evaluate((element) => {
          const host = getComputedStyle(element);
          const highlight = getComputedStyle(element, "::after");
          return {
            hostAnimation: host.animationName,
            hostBackground: host.backgroundImage,
            hostOverflow: host.overflow,
            highlightAnimation: highlight.animationName,
            highlightBackground: highlight.backgroundImage,
            highlightWillChange: highlight.willChange,
          };
        });

        expect(styles).toMatchObject({
          hostAnimation: "none",
          hostBackground: "none",
          hostOverflow: "hidden",
          highlightAnimation: "shimmer",
          highlightWillChange: "transform",
        });
        expect(styles.highlightBackground).toContain("linear-gradient");
      }
    } finally {
      await page.close().catch(() => {});
    }
  });

  it("keeps the global reduced-motion gate", async () => {
    const page = await browser.newPage({ reducedMotion: "reduce" });
    try {
      await page.setContent(`<!doctype html><html><head><style>
        ${readStyleSheet("ui/src/styles/base.css")}
        ${readStyleSheet("ui/src/styles/memory-import.css")}
        ${readStyleSheet("ui/src/styles/usage.css")}
      </style></head><body>
        <div class="skeleton skeleton-line"></div>
        <div class="skeleton usage-skeleton-block"></div>
        <div class="skeleton memory-import__skeleton"></div>
      </body></html>`);

      for (const selector of [
        ".skeleton-line",
        ".usage-skeleton-block",
        ".memory-import__skeleton",
      ]) {
        const animation = await page.locator(selector).evaluate((element) => {
          const highlight = getComputedStyle(element, "::after");
          return {
            duration: highlight.animationDuration,
            iterations: highlight.animationIterationCount,
          };
        });

        expect(animation).toEqual({ duration: "1e-05s", iterations: "1" });
      }
    } finally {
      await page.close().catch(() => {});
    }
  });
});
