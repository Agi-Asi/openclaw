import path from "node:path";
import { expect, it } from "vitest";
import {
  captureUiProof,
  captureUiProofEnabled,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  requireRecord,
  sessionsListResponse,
  uiProofArtifactDir,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("keeps profile-less run sessions visible in the mobile drawer", async () => {
    const sessionKeys = ["agent:main:mobile-one", "agent:main:mobile-two"] as const;
    const context = await suite.browser.newContext({
      hasTouch: true,
      locale: "en-US",
      recordVideo: captureUiProofEnabled
        ? { dir: uiProofArtifactDir, size: { height: 844, width: 390 } }
        : undefined,
      serviceWorkers: "block",
      viewport: { height: 844, width: 390 },
    });
    const page = await context.newPage();
    const proofVideo = page.video();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          {
            createdVia: "run",
            derivedTitle: "Mobile session one",
            key: sessionKeys[0],
            kind: "direct",
            updatedAt: 2,
          },
          {
            createdVia: "run",
            derivedTitle: "Mobile session two",
            key: sessionKeys[1],
            kind: "direct",
            updatedAt: 1,
          },
        ]),
      },
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
      const drawerToggle = page
        .locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible")
        .first();
      await drawerToggle.click();
      await expect
        .poll(() => page.locator(".shell").getAttribute("class"))
        .toContain("shell--nav-drawer-open");

      await expect
        .poll(async () =>
          (await gateway.getRequests("sessions.list")).some((request) => {
            const params = requireRecord(request.params);
            return params.agentId === "main" && params.includeDerivedTitles === true;
          }),
        )
        .toBe(true);
      for (const [index, title] of ["Mobile session one", "Mobile session two"].entries()) {
        await page
          .locator(`[data-session-key="${sessionKeys[index]}"]`)
          .getByText(title, { exact: true })
          .waitFor({ state: "visible" });
      }
      await captureUiProof(page, "mobile-profile-less-run-sessions.png");
    } finally {
      await context.close();
      if (proofVideo) {
        await proofVideo.saveAs(
          path.join(uiProofArtifactDir, "mobile-profile-less-run-sessions.webm"),
        );
      }
    }
  });
});
