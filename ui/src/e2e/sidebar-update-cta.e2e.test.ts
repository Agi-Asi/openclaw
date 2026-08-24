import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway, startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const proofArtifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "sidebar-update-cta",
);

async function surfaceStyle(locator: Locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      boxShadow: style.boxShadow,
      cursor: style.cursor,
      transform: style.transform,
    };
  });
}

async function setTheme(page: Page, mode: "dark" | "light") {
  await page.emulateMedia({ colorScheme: mode });
  await page.evaluate((nextMode) => {
    const root = document.documentElement;
    root.dataset.themeMode = nextMode;
    root.dataset.themeResolved = nextMode;
    root.classList.toggle("wa-light", nextMode === "light");
    root.classList.toggle("wa-dark", nextMode === "dark");
    root.style.colorScheme = nextMode;
  }, mode);
  await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe(mode);
}

async function captureProof(page: Page, fileName: string, locators: readonly Locator[]) {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
    return;
  }
  const boxes: Array<{ x: number; y: number; width: number; height: number }> = [];
  for (const locator of locators) {
    await locator.waitFor({ state: "visible" });
    await locator.evaluate(async (element) => {
      const running = element
        .getAnimations({ subtree: true })
        .filter((animation) => animation.playState === "running");
      await Promise.all(running.map((animation) => animation.finished.catch(() => undefined)));
    });
    const box = await locator.boundingBox();
    if (!box) {
      throw new Error(`Cannot capture ${fileName}: a proof surface has no bounding box`);
    }
    boxes.push(box);
  }
  const viewport = page.viewportSize();
  if (!viewport) {
    throw new Error(`Cannot capture ${fileName}: viewport is unavailable`);
  }
  const margin = 12;
  const x = Math.max(0, Math.min(...boxes.map((box) => box.x)) - margin);
  const y = Math.max(0, Math.min(...boxes.map((box) => box.y)) - margin);
  const right = Math.min(
    viewport.width,
    Math.max(...boxes.map((box) => box.x + box.width)) + margin,
  );
  const bottom = Math.min(
    viewport.height,
    Math.max(...boxes.map((box) => box.y + box.height)) + margin,
  );
  await mkdir(proofArtifactDir, { recursive: true });
  await page.screenshot({
    clip: { x, y, width: right - x, height: bottom - y },
    path: path.join(proofArtifactDir, fileName),
  });
}

const suite = createControlUiE2eSuite({
  name: "Control UI sidebar update CTA E2E",
  browserLaunchOptions: { headless: process.env.OPENCLAW_UI_E2E_HEADED !== "1" },
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

suite.define(() => {
  it.each(["light", "dark"] as const)(
    "keeps the informational update strip static in %s mode",
    async (theme) => {
      await suite.withPage(
        {
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 900, width: 1440 },
        },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            methodResponses: {
              "update.run": {
                ok: true,
                restart: null,
                result: { after: { version: "2.0.0" }, status: "ok" },
              },
            },
            presenceUsers: [
              {
                self: true,
                id: "riley",
                name: "Riley",
                email: "riley.with.a.deliberately.long.address@example.test",
              },
            ],
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          const sidebar = page.locator("openclaw-app-sidebar");
          await sidebar.locator(".sidebar-identity-card").waitFor();
          const footer = sidebar.locator(".sidebar-footer-bar");
          await setTheme(page, theme);
          await page.mouse.move(0, 0);

          expect(await sidebar.locator(".sidebar-update-card").count()).toBe(0);
          await captureProof(page, `${theme}-no-update-footer.png`, [footer]);

          await gateway.emitGatewayEvent("update.available", {
            updateAvailable: {
              channel: "stable",
              currentVersion: "1.0.0",
              latestVersion: "2.0.0",
            },
          });
          const card = sidebar.locator(".sidebar-update-card");
          const availability = sidebar.locator(".sidebar-update-card__availability");
          const copy = availability.locator(".sidebar-update-card__text");
          const cta = availability.getByRole("button", { name: "Update", exact: true });
          await availability.waitFor();

          expect(await card.getAttribute("role")).toBe("status");
          expect(await card.getAttribute("tabindex")).toBeNull();
          expect(await availability.getAttribute("role")).toBeNull();
          expect((await copy.textContent())?.trim()).toBe("New version available");
          expect(await availability.getByRole("button").count()).toBe(1);
          expect(await sidebar.locator(".sidebar-update-card__dismiss").count()).toBe(0);

          const restSurface = await surfaceStyle(availability);
          const restCta = await surfaceStyle(cta);
          await captureProof(page, `${theme}-update-rest.png`, [availability, footer]);

          await copy.hover();
          await copy.click();
          expect(await page.getByRole("dialog").count()).toBe(0);
          expect(await gateway.getRequests("update.run")).toHaveLength(0);
          expect(await surfaceStyle(availability)).toEqual(restSurface);
          await captureProof(page, `${theme}-container-click.png`, [availability, footer]);

          await cta.hover();
          await expect.poll(() => surfaceStyle(cta)).not.toEqual(restCta);
          expect(await surfaceStyle(availability)).toEqual(restSurface);
          await captureProof(page, `${theme}-cta-hover.png`, [availability, footer, cta]);

          await page.mouse.move(0, 0);
          await cta.focus();
          await captureProof(page, `${theme}-cta-focus.png`, [availability, footer, cta]);

          await page.keyboard.press("Enter");
          const dialog = page.getByRole("dialog");
          await dialog.waitFor();
          expect(await dialog.getAttribute("aria-label")).toBe("Update Gateway");
          expect(await gateway.getRequests("update.run")).toHaveLength(0);
          await captureProof(page, `${theme}-confirmation.png`, [availability, footer, dialog]);
        },
      );
    },
  );
});
