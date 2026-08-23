import path from "node:path";
import { expect, it } from "vitest";
import {
  activateSelfRemovingControl,
  captureUiProof,
  captureUiProofEnabled,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionRow,
  sessionsListResponse,
  trimmedTextContents,
  uiProofArtifactDir,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

const candidateKey = "agent:main:candidate";
const companionKey = "agent:main:companion";
const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
const pinFeatureMethods = ["chat.metadata", "chat.startup", "sessions.patch"];

function unpinnedList() {
  return sessionsListResponse([
    sessionRow(candidateKey, "Pin me", baseTime),
    sessionRow(companionKey, "Stay put", baseTime - 1_000),
  ]);
}

function pinnedList() {
  return sessionsListResponse([
    sessionRow(candidateKey, "Pin me", baseTime, { pinned: true, pinnedAt: baseTime }),
    sessionRow(companionKey, "Stay put", baseTime - 1_000),
  ]);
}

function groupedList(categoryPinnedAt?: number) {
  return sessionsListResponse([
    sessionRow(companionKey, "Stay put", baseTime, { category: "Research" }),
    sessionRow(candidateKey, "Pin me", baseTime - 1_000, {
      category: "Research",
      ...(categoryPinnedAt === undefined ? {} : { categoryPinnedAt }),
    }),
  ]);
}

function globallyPinnedList(category = "Research") {
  return sessionsListResponse([
    sessionRow(candidateKey, "Pin me", baseTime, {
      category,
      pinned: true,
      pinnedAt: baseTime,
    }),
    sessionRow(companionKey, "Stay put", baseTime - 1_000, { category: "Research" }),
  ]);
}

suite.define(() => {
  it("pins within a group from More actions while the patch is in flight", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      recordVideo: captureUiProofEnabled
        ? { dir: uiProofArtifactDir, size: { height: 900, width: 1280 } }
        : undefined,
    });
    const page = await context.newPage();
    const proofVideo = page.video();
    const gateway = await installMockGateway(page, {
      methodResponses: { "sessions.list": groupedList(), "sessions.patch": {} },
      featureMethods: [...pinFeatureMethods, "sessions.groups.list", "sessions.groups.put"],
      sessionGroups: ["Research"],
      sessionKey: candidateKey,
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const group = page.locator('[data-session-section="category:Research"]');
      const row = group.locator(`.sidebar-recent-session[data-session-key="${candidateKey}"]`);
      await expect
        .poll(() => trimmedTextContents(group.locator(".sidebar-recent-session__name")))
        .toEqual(["Stay put", "Pin me"]);
      await captureUiProof(page, "group-pin-00-before.png");
      if (captureUiProofEnabled) {
        await page.waitForTimeout(700);
      }

      await row.hover();
      await row.getByRole("button", { name: "Open session menu: Pin me" }).click();
      const menu = page.locator("openclaw-session-menu");
      await expect.poll(() => menu.getByRole("menuitem", { name: "Pin globally" }).count()).toBe(1);
      await captureUiProof(page, "group-pin-01-root-menu.png");
      if (captureUiProofEnabled) {
        await page.waitForTimeout(700);
      }

      await menu.getByRole("menuitem", { name: "More actions" }).click();
      await expect
        .poll(() => menu.getByRole("menuitem", { name: "Pin in Research" }).count())
        .toBe(1);
      await captureUiProof(page, "group-pin-02-more-actions.png");
      if (captureUiProofEnabled) {
        await page.waitForTimeout(700);
      }

      await menu.getByRole("menuitem", { name: "Set icon" }).click();
      await expect.poll(() => menu.getByRole("button", { name: "Custom emoji…" }).count()).toBe(1);
      await captureUiProof(page, "group-pin-02b-more-set-icon.png");
      if (captureUiProofEnabled) {
        await page.waitForTimeout(700);
      }
      await menu.getByRole("menuitem", { name: "Back" }).click();
      await expect
        .poll(() => menu.getByRole("menuitem", { name: "Pin in Research" }).count())
        .toBe(1);

      await gateway.deferNext("sessions.patch");
      await activateSelfRemovingControl(menu.getByRole("menuitem", { name: "Pin in Research" }));

      await expect
        .poll(async () => {
          const requests = await gateway.getRequests("sessions.patch");
          return requests.at(-1)?.params;
        })
        .toMatchObject({ key: candidateKey, pinScope: "group" });
      expect(await page.locator(`[data-sidebar-entry="session:${candidateKey}"]`).count()).toBe(0);
      await expect
        .poll(() =>
          group
            .locator(".sidebar-recent-session__name")
            .allTextContents()
            .then((labels) => labels.map((label) => label.trim())),
        )
        .toEqual(["Pin me", "Stay put"]);
      await captureUiProof(page, "group-pin-03-pinned-in-group.png");
      if (captureUiProofEnabled) {
        await page.waitForTimeout(700);
      }

      await gateway.setMethodResponse("sessions.list", groupedList(baseTime + 1_000));
      await gateway.resolveDeferred("sessions.patch", {
        ok: true,
        key: candidateKey,
        path: "",
        entry: { sessionId: `session:${candidateKey}`, categoryPinnedAt: baseTime + 1_000 },
      });
      await expect.poll(() => gateway.getRequests("sessions.list")).toHaveLength(2);

      await row.hover();
      await row.getByRole("button", { name: "Open session menu: Pin me" }).click();
      await expect
        .poll(() => menu.getByRole("menuitem", { name: "Move pin globally" }).count())
        .toBe(1);
      await menu.getByRole("menuitem", { name: "More actions" }).click();
      await expect
        .poll(() => menu.getByRole("menuitem", { name: "Unpin from Research" }).count())
        .toBe(1);
      await captureUiProof(page, "group-pin-04-confirmed.png");
      if (captureUiProofEnabled) {
        await page.waitForTimeout(700);
      }
    } finally {
      await context.close();
      if (proofVideo) {
        await proofVideo.saveAs(path.join(uiProofArtifactDir, "group-pin-more-actions.webm"));
      }
    }
  });

  it("uses global scope for the row quick-pin action", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: { "sessions.list": groupedList(), "sessions.patch": {} },
      featureMethods: [...pinFeatureMethods, "sessions.groups.list", "sessions.groups.put"],
      sessionGroups: ["Research"],
      sessionKey: candidateKey,
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const group = page.locator('[data-session-section="category:Research"]');
      const row = group.locator(`.sidebar-recent-session[data-session-key="${candidateKey}"]`);
      const zoneEntry = page.locator(`[data-sidebar-entry="session:${candidateKey}"]`);
      await gateway.deferNext("sessions.patch");
      await row.hover();
      await row.getByRole("button", { name: "Pin globally: Pin me" }).click();

      await expect
        .poll(async () => (await gateway.getRequests("sessions.patch")).at(-1)?.params)
        .toMatchObject({ key: candidateKey, pinScope: "global" });
      await expect.poll(() => zoneEntry.count()).toBe(1);
      await expect.poll(() => row.count()).toBe(0);

      await gateway.setMethodResponse("sessions.list", globallyPinnedList());
      await gateway.resolveDeferred("sessions.patch", { ok: true, key: candidateKey, path: "" });
      await expect.poll(() => gateway.getRequests("sessions.list")).toHaveLength(2);
      await expect.poll(() => zoneEntry.count()).toBe(1);
    } finally {
      await context.close();
    }
  });

  it("preserves a global pin when moving it to another group from the session menu", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: { "sessions.list": globallyPinnedList(), "sessions.patch": {} },
      featureMethods: [...pinFeatureMethods, "sessions.groups.list", "sessions.groups.put"],
      sessionGroups: ["Research", "Planning"],
      sessionKey: candidateKey,
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const row = page.locator(
        `[data-sidebar-entry="session:${candidateKey}"] .sidebar-recent-session`,
      );
      await row.hover();
      await row.getByRole("button", { name: "Open session menu: Pin me" }).click();
      const menu = page.locator("openclaw-session-menu");
      await menu.getByRole("menuitem", { name: "Move to group" }).click();
      await gateway.deferNext("sessions.patch");
      await activateSelfRemovingControl(
        menu.getByRole("menuitemradio", { name: "Planning", exact: true }),
      );

      await expect
        .poll(async () => (await gateway.getRequests("sessions.patch")).at(-1)?.params)
        .toMatchObject({ category: "Planning", key: candidateKey });
      const patchParams = (await gateway.getRequests("sessions.patch")).at(-1)?.params;
      expect(patchParams).not.toHaveProperty("pinScope");

      await gateway.setMethodResponse("sessions.list", globallyPinnedList("Planning"));
      await gateway.resolveDeferred("sessions.patch", { ok: true, key: candidateKey, path: "" });
      await expect.poll(() => gateway.getRequests("sessions.list")).toHaveLength(2);
      await expect
        .poll(() => page.locator(`[data-sidebar-entry="session:${candidateKey}"]`).count())
        .toBe(1);
      await expect
        .poll(() =>
          page
            .locator(
              `[data-session-section="category:Planning"] [data-session-key="${candidateKey}"]`,
            )
            .count(),
        )
        .toBe(0);
    } finally {
      await context.close();
    }
  });

  it("unpins a global shelf row when dragging it into a group", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: { "sessions.list": globallyPinnedList(), "sessions.patch": {} },
      featureMethods: [...pinFeatureMethods, "sessions.groups.list", "sessions.groups.put"],
      sessionGroups: ["Research", "Planning"],
      sessionKey: candidateKey,
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const pinnedRow = page.locator(
        `[data-sidebar-entry="session:${candidateKey}"] .sidebar-recent-session`,
      );
      const planningGroup = page.locator('[data-session-section="category:Planning"]');
      const sourceBox = await pinnedRow.boundingBox();
      const targetBox = await planningGroup.boundingBox();
      if (!sourceBox || !targetBox) {
        throw new Error("expected global pin and Planning group bounds");
      }
      await gateway.deferNext("sessions.patch");
      await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, {
        steps: 8,
      });
      await page.mouse.up();

      await expect
        .poll(async () => (await gateway.getRequests("sessions.patch")).at(-1)?.params)
        .toMatchObject({ category: "Planning", key: candidateKey, pinScope: null });

      await gateway.setMethodResponse(
        "sessions.list",
        sessionsListResponse([
          sessionRow(candidateKey, "Pin me", baseTime, { category: "Planning" }),
          sessionRow(companionKey, "Stay put", baseTime - 1_000, { category: "Research" }),
        ]),
      );
      await gateway.resolveDeferred("sessions.patch", { ok: true, key: candidateKey, path: "" });
      await expect.poll(() => gateway.getRequests("sessions.list")).toHaveLength(2);
      await expect
        .poll(() => page.locator(`[data-sidebar-entry="session:${candidateKey}"]`).count())
        .toBe(0);
      await expect
        .poll(() =>
          planningGroup
            .locator(`.sidebar-recent-session[data-session-key="${candidateKey}"]`)
            .count(),
        )
        .toBe(1);
    } finally {
      await context.close();
    }
  });

  it("pins from the row button while the Gateway patch is still in flight", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      recordVideo: captureUiProofEnabled
        ? { dir: uiProofArtifactDir, size: { height: 900, width: 1280 } }
        : undefined,
    });
    const page = await context.newPage();
    const proofVideo = page.video();
    const gateway = await installMockGateway(page, {
      methodResponses: { "sessions.list": unpinnedList(), "sessions.patch": {} },
      featureMethods: pinFeatureMethods,
      sessionKey: candidateKey,
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const zoneEntry = page.locator(`[data-sidebar-entry="session:${candidateKey}"]`);
      const threads = page.locator('[data-session-section="ungrouped"]');
      const row = threads.locator(`.sidebar-recent-session[data-session-key="${candidateKey}"]`);
      await expect.poll(() => row.count()).toBe(1);
      await expect.poll(() => zoneEntry.count()).toBe(0);
      await captureUiProof(page, "optimistic-pin-01-before-click.png");

      await gateway.deferNext("sessions.patch");
      await row.hover();
      await row.getByRole("button", { name: "Pin globally: Pin me" }).click();

      // The Gateway response is still held, so this can only come from the
      // optimistic snapshot write in the mutation owner.
      await expect.poll(() => zoneEntry.count()).toBe(1);
      await expect.poll(() => row.count()).toBe(0);
      expect(await gateway.getRequests("sessions.list")).toHaveLength(1);
      await captureUiProof(page, "optimistic-pin-02-pinned-while-in-flight.png");

      await gateway.setMethodResponse("sessions.list", pinnedList());
      await gateway.resolveDeferred("sessions.patch", { ok: true, key: candidateKey, path: "" });

      await expect.poll(() => gateway.getRequests("sessions.list")).toHaveLength(2);
      await expect.poll(() => zoneEntry.count()).toBe(1);
      await expect.poll(() => row.count()).toBe(0);
      expect(await page.locator("[data-sidebar-session-error]").count()).toBe(0);
      await captureUiProof(page, "optimistic-pin-03-confirmed-after-refresh.png");
    } finally {
      await context.close();
      if (proofVideo) {
        await proofVideo.saveAs(path.join(uiProofArtifactDir, "optimistic-pin-button.webm"));
      }
    }
  });

  it("rolls a menu unpin back and surfaces the error when the Gateway rejects it", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: { "sessions.list": pinnedList(), "sessions.patch": {} },
      featureMethods: pinFeatureMethods,
      sessionKey: candidateKey,
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const zoneEntry = page.locator(`[data-sidebar-entry="session:${candidateKey}"]`);
      const threads = page.locator('[data-session-section="ungrouped"]');
      const row = threads.locator(`.sidebar-recent-session[data-session-key="${candidateKey}"]`);
      await expect.poll(() => zoneEntry.count()).toBe(1);

      await gateway.deferNext("sessions.patch");
      const pinnedRow = zoneEntry.locator(".sidebar-recent-session");
      await pinnedRow.hover();
      await pinnedRow.getByRole("button", { name: "Open session menu: Pin me" }).click();
      const menuHost = page.locator("openclaw-session-menu");
      await activateSelfRemovingControl(menuHost.getByRole("menuitem", { name: "Unpin globally" }));

      await expect.poll(() => zoneEntry.count()).toBe(0);
      await expect.poll(() => row.count()).toBe(1);
      await captureUiProof(page, "optimistic-pin-04-unpinned-while-in-flight.png");

      await gateway.rejectDeferred("sessions.patch", { message: "pin storage unavailable" });

      await expect.poll(() => zoneEntry.count()).toBe(1);
      await expect.poll(() => row.count()).toBe(0);
      await expect
        .poll(() => trimmedTextContents(page.locator("[data-sidebar-session-error]")))
        .toEqual([expect.stringContaining("pin storage unavailable")]);
      await captureUiProof(page, "optimistic-pin-05-rolled-back-with-error.png");
    } finally {
      await context.close();
    }
  });

  it("keeps the newest pin intent when the older completion refreshes the list first", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: { "sessions.list": unpinnedList(), "sessions.patch": {} },
      featureMethods: pinFeatureMethods,
      sessionKey: candidateKey,
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const zoneEntry = page.locator(`[data-sidebar-entry="session:${candidateKey}"]`);
      const threads = page.locator('[data-session-section="ungrouped"]');
      const row = threads.locator(`.sidebar-recent-session[data-session-key="${candidateKey}"]`);
      await expect.poll(() => row.count()).toBe(1);

      await gateway.deferNext("sessions.patch");
      await row.hover();
      await row.getByRole("button", { name: "Pin globally: Pin me" }).click();
      await expect.poll(() => zoneEntry.count()).toBe(1);

      await gateway.deferNext("sessions.patch");
      const pinnedRow = zoneEntry.locator(".sidebar-recent-session");
      await pinnedRow.hover();
      await pinnedRow.getByRole("button", { name: "Unpin globally: Pin me" }).click();
      await expect.poll(() => row.count()).toBe(1);
      await expect.poll(() => zoneEntry.count()).toBe(0);

      // The pin commits first; its list refresh still carries the pinned row the
      // unpin already replaced locally.
      await gateway.setMethodResponse("sessions.list", pinnedList());
      await gateway.resolveDeferred("sessions.patch", { ok: true, key: candidateKey, path: "" });
      await expect.poll(() => gateway.getRequests("sessions.list")).toHaveLength(2);
      await expect.poll(() => row.count()).toBe(1);
      expect(await zoneEntry.count()).toBe(0);

      await gateway.setMethodResponse("sessions.list", unpinnedList());
      await gateway.resolveDeferred("sessions.patch", { ok: true, key: candidateKey, path: "" });
      await expect.poll(() => gateway.getRequests("sessions.list")).toHaveLength(3);
      await expect.poll(() => row.count()).toBe(1);
      expect(await zoneEntry.count()).toBe(0);
      await captureUiProof(page, "optimistic-pin-06-newest-intent-wins.png");
    } finally {
      await context.close();
    }
  });
});
