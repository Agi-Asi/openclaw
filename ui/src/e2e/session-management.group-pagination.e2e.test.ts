import { expect, it } from "vitest";
import {
  captureUiProof,
  captureUiProofEnabled,
  collapsedSessionSectionsStorageKey,
  createSessionManagementE2eSuite,
  installMockGateway,
  requireRecord,
  sessionRow,
  sessionsListResponse,
  uiProofArtifactDir,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("pages an expanded custom group independently of the global session window", async () => {
    const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
    const jesseRows = Array.from({ length: 11 }, (_, index) =>
      sessionRow(`agent:main:jesse-${index}`, `Jesse session ${index + 1}`, baseTime - index, {
        category: "Jesse",
      }),
    );
    const firstPage = [
      jesseRows[0],
      ...Array.from({ length: 59 }, (_, index) =>
        sessionRow(
          `agent:main:other-${index}`,
          `Other session ${index + 1}`,
          baseTime - 100 - index,
          {
            category: "Other",
          },
        ),
      ),
    ];
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      recordVideo: captureUiProofEnabled
        ? { dir: uiProofArtifactDir, size: { height: 900, width: 1280 } }
        : undefined,
    });
    const page = await context.newPage();
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
      key: collapsedSessionSectionsStorageKey,
      value: JSON.stringify(["category:Jesse", "category:Other"]),
    });
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": {
          cases: [
            { match: { category: "Jesse", limit: 20 }, response: sessionsListResponse(jesseRows) },
            {
              match: { category: "Jesse", limit: 10 },
              response: sessionsListResponse(jesseRows.slice(0, 10), {
                hasMore: true,
                nextOffset: 10,
                totalCount: 11,
              }),
            },
            {
              response: sessionsListResponse(firstPage, {
                hasMore: true,
                nextOffset: 60,
                totalCount: 70,
              }),
            },
          ],
        },
      },
      featureMethods: ["chat.metadata", "chat.startup", "sessions.groups.list"],
      sessionGroups: ["Jesse", "Other"],
      sessionKey: "agent:main:jesse-0",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const group = page.locator('[data-session-section="category:Jesse"]');
      await group.waitFor({ state: "visible", timeout: 10_000 });
      await expect.poll(() => group.locator(".sidebar-recent-session").count()).toBe(0);
      await captureUiProof(page, "sidebar-jesse-group-collapsed.png");

      await group.getByRole("button", { name: "Jesse", exact: true }).click();
      await expect.poll(() => group.locator(".sidebar-recent-session").count()).toBe(10);
      await expect
        .poll(async () =>
          (await gateway.getRequests("sessions.list")).some((request) => {
            const params = requireRecord(request.params);
            return params.category === "Jesse" && params.limit === 10;
          }),
        )
        .toBe(true);
      await captureUiProof(page, "sidebar-jesse-group-first-page.png");

      await group.getByRole("button", { name: "Show more" }).click();
      await expect.poll(() => group.locator(".sidebar-recent-session").count()).toBe(11);
      await expect
        .poll(async () =>
          (await gateway.getRequests("sessions.list")).some((request) => {
            const params = requireRecord(request.params);
            return params.category === "Jesse" && params.limit === 20;
          }),
        )
        .toBe(true);
      await captureUiProof(page, "sidebar-jesse-group-complete.png");
    } finally {
      await context.close();
    }
  });
});
