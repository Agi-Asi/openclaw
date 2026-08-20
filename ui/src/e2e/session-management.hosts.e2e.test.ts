import { expect, it } from "vitest";
import {
  captureUiProof,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionRow,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("groups and filters sidebar sessions by execution host", async () => {
    const baseTime = Date.parse("2026-08-20T16:00:00.000Z");
    const placement = {
      createdAtMs: baseTime,
      generation: 1,
      state: "requested" as const,
      stateChangedAtMs: baseTime,
      updatedAtMs: baseTime,
    };
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:gateway", "Gateway planning", baseTime),
          sessionRow("agent:main:studio-a", "iOS signing", baseTime - 1, {
            execNode: "Mac Studio",
          }),
          sessionRow("agent:main:studio-b", "Desktop smoke", baseTime - 2, {
            execNode: "Mac Studio",
          }),
          sessionRow("agent:main:cloud", "Crabbox proof", baseTime - 3, { placement }),
          sessionRow("agent:main:cloud-pinned", "Release validation", baseTime - 4, {
            pinned: true,
            pinnedAt: baseTime - 4,
            placement,
          }),
        ]),
      },
      sessionKey: "agent:main:gateway",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const filterAndSortButton = page.getByRole("button", { name: "Filter & sort" });
      await filterAndSortButton.click();
      await page.getByRole("menuitemradio", { name: "Host" }).click();

      await expect.poll(() => filterAndSortButton.getAttribute("aria-expanded")).toBe("true");
      await page.locator('[data-session-section="host:gateway"]').waitFor({ state: "visible" });
      await page.locator('[data-session-section="host:node:Mac Studio"]').waitFor({
        state: "visible",
      });
      await page.locator('[data-session-section="host:cloud"]').waitFor({ state: "visible" });
      await page.getByText("Filter hosts", { exact: true }).waitFor({ state: "visible" });
      await page.getByRole("menuitemcheckbox", { name: "All hosts" }).waitFor();
      await page.getByRole("menuitemcheckbox", { name: "Gateway (1)" }).waitFor();
      await page.getByRole("menuitemcheckbox", { name: "Mac Studio (2)" }).waitFor();
      const cloudFilter = page.getByRole("menuitemcheckbox", { name: "Cloud workers (2)" });
      await cloudFilter.waitFor();
      await captureUiProof(page, "sidebar-host-grouping-and-filters.png");

      await cloudFilter.click();
      await expect.poll(() => page.locator('[data-session-section="host:cloud"]').count()).toBe(0);
      await expect
        .poll(() => page.locator('[data-session-key="agent:main:cloud"]').count())
        .toBe(0);
      await expect
        .poll(() => page.locator('[data-session-key="agent:main:cloud-pinned"]').count())
        .toBe(0);
      const hiddenCloudFilter = page.getByRole("menuitemcheckbox", { name: /Cloud workers/ });
      if ((await hiddenCloudFilter.count()) === 0) {
        if ((await filterAndSortButton.getAttribute("aria-expanded")) === "true") {
          await filterAndSortButton.click();
          await expect.poll(() => filterAndSortButton.getAttribute("aria-expanded")).toBe("false");
        }
        await filterAndSortButton.click();
      }
      await hiddenCloudFilter.waitFor({ state: "visible" });
      await expect.poll(() => hiddenCloudFilter.getAttribute("aria-checked")).toBe("false");
      await captureUiProof(page, "sidebar-host-filtered.png");

      await page.reload();
      await page.locator('[data-session-section="host:gateway"]').waitFor({ state: "visible" });
      await expect.poll(() => page.locator('[data-session-section="host:cloud"]').count()).toBe(0);

      await page.getByRole("button", { name: "Filter & sort" }).click();
      await page.getByRole("menuitemcheckbox", { name: "All hosts" }).click();
      await page.locator('[data-session-section="host:cloud"]').waitFor({ state: "visible" });
      await page.locator('[data-session-key="agent:main:cloud-pinned"]').waitFor({
        state: "visible",
      });
    } finally {
      await context.close();
    }
  });
});
