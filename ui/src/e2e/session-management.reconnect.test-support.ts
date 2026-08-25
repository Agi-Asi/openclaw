import { expect, it } from "vitest";
import {
  waitForControlUiGatewayReady,
  waitForControlUiGatewayReconnecting,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import { expectRequestCountStable } from "./chat-flow.test-support.ts";
import {
  captureUiProof,
  installMockGateway,
  sessionRow,
  sessionsListResponse,
  type createSessionManagementE2eSuite,
} from "./session-management.test-support.ts";

export function defineSessionManagementReconnectCases(
  suite: ReturnType<typeof createSessionManagementE2eSuite>,
) {
  it("keeps pinned sidebar sessions visible through reconnect and client replacement", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const sessionKey = "agent:main:disconnect-proof";
    const otherSessionKeys = ["agent:main:other-a", "agent:main:other-b"] as const;
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow(sessionKey, "Disconnect proof", Date.parse("2026-07-01T16:00:00.000Z"), {
            pinned: true,
          }),
          sessionRow(otherSessionKeys[0], "Other A", Date.parse("2026-07-01T15:59:00.000Z"), {
            pinned: true,
          }),
          sessionRow(otherSessionKeys[1], "Other B", Date.parse("2026-07-01T15:58:00.000Z"), {
            pinned: true,
          }),
        ]),
      },
      sessionKey,
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const sidebarRow = page.locator(`.sidebar-recent-session[data-session-key="${sessionKey}"]`);
      const pinnedEntry = page.locator(`[data-sidebar-entry="session:${sessionKey}"]`);
      await sidebarRow.waitFor({ state: "visible", timeout: 10_000 });
      await pinnedEntry.waitFor({ state: "visible" });
      const sidebarRows = page.locator(".sidebar-recent-session");
      await expect.poll(() => sidebarRows.count()).toBe(3);
      await captureUiProof(page, "sidebar-sessions-before-reconnect.png");
      const initialListCount = (await gateway.getRequests("sessions.list")).length;

      const socketsBefore = await gateway.getSocketCount();
      await gateway.setOnline(false);
      await waitForControlUiGatewayReconnecting(page);
      await expect.poll(() => sidebarRow.textContent()).toContain("Disconnect proof");
      await expect.poll(() => sidebarRows.count()).toBe(3);
      for (const otherKey of otherSessionKeys) {
        await page
          .locator(`.sidebar-recent-session[data-session-key="${otherKey}"]`)
          .waitFor({ state: "visible" });
      }
      await captureUiProof(page, "sidebar-sessions-during-reconnect.png");

      await expect
        .poll(() => gateway.getSocketCount(), { timeout: 15_000 })
        .toBe(socketsBefore + 1);
      await gateway.deferNext("sessions.list", { includeLastMessage: true });
      await gateway.setOnline(true);
      await waitForControlUiGatewayReady(page);
      await expect
        .poll(async () => (await gateway.getRequests("sessions.list")).length, { timeout: 15_000 })
        .toBeGreaterThan(initialListCount);
      await sidebarRow.waitFor({ state: "visible" });
      expect(await sidebarRows.count()).toBe(3);
      for (const otherKey of otherSessionKeys) {
        await page
          .locator(`.sidebar-recent-session[data-session-key="${otherKey}"]`)
          .waitFor({ state: "visible" });
      }

      const firstReconnectListCount = (await gateway.getRequests("sessions.list")).length;
      const refreshedResponse = sessionsListResponse([
        sessionRow(sessionKey, "Reconnect refreshed", Date.parse("2026-07-01T16:01:00.000Z"), {
          pinned: true,
        }),
        sessionRow(otherSessionKeys[0], "Other A", Date.parse("2026-07-01T15:59:00.000Z"), {
          pinned: true,
        }),
        sessionRow(otherSessionKeys[1], "Other B", Date.parse("2026-07-01T15:58:00.000Z"), {
          pinned: true,
        }),
      ]);
      await gateway.resolveDeferred("sessions.list", refreshedResponse);
      await expect.poll(() => sidebarRow.textContent()).toContain("Reconnect refreshed");
      await expect.poll(() => sidebarRows.count()).toBe(3);
      await expectRequestCountStable(gateway, "sessions.list", firstReconnectListCount);

      const replacementListCount = (await gateway.getRequests("sessions.list")).length;
      const socketsBeforeReplacement = await gateway.getSocketCount();
      await gateway.deferNext("sessions.list", { includeLastMessage: true });
      await page.evaluate(() => {
        const app = document.querySelector("openclaw-app") as HTMLElement & {
          runtime?: {
            context: {
              gateway: {
                connection: { gatewayUrl: string; token: string };
                connect(overrides: { gatewayUrl: string; token: string }): void;
              };
            };
          };
        };
        const activeGateway = app.runtime?.context.gateway;
        if (!activeGateway) {
          throw new Error("OpenClaw application Gateway is unavailable");
        }
        activeGateway.connect({
          gatewayUrl: activeGateway.connection.gatewayUrl,
          token: activeGateway.connection.token,
        });
      });
      await expect
        .poll(() => gateway.getSocketCount(), { timeout: 15_000 })
        .toBe(socketsBeforeReplacement + 1);
      await expect
        .poll(async () => (await gateway.getRequests("sessions.list")).length, {
          timeout: 15_000,
        })
        .toBe(replacementListCount + 1);
      await expect.poll(() => sidebarRows.count()).toBe(3);
      await sidebarRow.waitFor({ state: "visible" });
      await pinnedEntry.waitFor({ state: "visible" });
      await captureUiProof(page, "sidebar-sessions-during-client-replacement.png");

      await gateway.resolveDeferred(
        "sessions.list",
        sessionsListResponse([
          sessionRow(sessionKey, "Replacement refreshed", Date.parse("2026-07-01T16:02:00.000Z"), {
            pinned: true,
          }),
          sessionRow(otherSessionKeys[0], "Other A", Date.parse("2026-07-01T15:59:00.000Z"), {
            pinned: true,
          }),
          sessionRow(otherSessionKeys[1], "Other B", Date.parse("2026-07-01T15:58:00.000Z"), {
            pinned: true,
          }),
        ]),
      );
      await expect.poll(() => sidebarRow.textContent()).toContain("Replacement refreshed");
    } finally {
      await context.close();
    }
  });
}
