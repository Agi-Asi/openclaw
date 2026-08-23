import { expect, it } from "vitest";
import {
  WORKSPACE,
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  installMockGateway,
  pollLocatorText,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const sessionKey = "agent:main:worktree-startup";
const operationId = "worktree-startup-operation";

suite.define(() => {
  it("opens the new session immediately with its first turn, setup output, and recovery actions", async () => {
    const context = await suite.browser.newContext({
      colorScheme: "light",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const startedAt = Date.now();
    const startupState = {
      kind: "managed-worktree",
      status: "initializing",
      operationId,
      stage: "checking-out",
      startedAt,
      updatedAt: startedAt + 1,
      output: "Preparing worktree\nChecking out files\n",
      initialTurn: { message: "fix the flaky worktree test" },
    } as const;
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "sessions.create",
        "sessions.startup.resolve",
        "worktrees.branches",
      ],
      methodResponses: {
        "sessions.create": { key: sessionKey, runStarted: false, startupState },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new?agent=main`);
      await page.locator("#new-session-detail-trigger").click();
      await page
        .locator("wa-popover.new-session-page__detail-popover")
        .getByRole("button", { name: "Worktree" })
        .click();
      await page.keyboard.press("Escape");
      await page.locator(".new-session-page__message").fill("fix the flaky worktree test");
      await page.getByRole("button", { name: "Start session" }).click();

      await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(sessionKey));
      await pollLocatorText(page.locator(".chat-group.user")).toContain(
        "fix the flaky worktree test",
      );
      await expect.poll(() => page.locator(".chat-group.user").count()).toBe(1);
      const startup = page.locator(".chat-worktree-startup");
      await pollLocatorText(startup).toContain("Checking out files");
      await expect(page.getByRole("button", { name: "Cancel" }).isVisible()).resolves.toBe(true);
      await expect(page.getByRole("button", { name: "Work locally" }).isVisible()).resolves.toBe(
        true,
      );
      await expect
        .poll(() => page.locator(".agent-chat__composer-combobox textarea").isDisabled())
        .toBe(true);

      await page.getByRole("button", { name: "Work locally" }).click();
      await expect(gateway.waitForRequest("sessions.startup.resolve")).resolves.toMatchObject({
        params: { action: "work-local", key: sessionKey, operationId },
      });

      await gateway.setMethodResponse("sessions.list", {
        count: 1,
        defaults: { contextTokens: 200_000, model: "gpt-5.6-luna", modelProvider: "openai" },
        path: "",
        sessions: [
          {
            key: sessionKey,
            kind: "direct",
            hasActiveRun: false,
            status: "done",
            updatedAt: startedAt + 2,
            startupState: {
              ...startupState,
              status: "completed",
              stage: "running-setup",
              updatedAt: startedAt + 2,
              worktreePath: "/tmp/openclaw-worktree",
            },
          },
        ],
        ts: startedAt + 2,
      });
      await gateway.emitGatewayEvent("sessions.changed", {
        sessionKey,
        agentId: "main",
        reason: "create",
      });
      await pollLocatorText(startup).toContain("Workspace ready");
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(gateway.waitForRequest("sessions.startup.resolve")).resolves.toMatchObject({
        params: { action: "work-local", key: sessionKey, operationId },
      });
      await expect
        .poll(() => page.locator(".agent-chat__composer-combobox textarea").isDisabled())
        .toBe(true);

      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
    } finally {
      await context.close();
    }
  });
});
