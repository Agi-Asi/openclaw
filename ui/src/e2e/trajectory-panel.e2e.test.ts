import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "trajectory side panel mocked Gateway E2E",
  startServerBeforeBrowser: true,
});

const proofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "trajectory-view");

function configResponse() {
  const config = { gateway: { controlUi: { trajectory: true } } };
  return {
    appliedConfigHash: "trajectory-config-1",
    config,
    configRevisionHash: "trajectory-config-1",
    hash: "trajectory-config-1",
    issues: [],
    raw: JSON.stringify(config, null, 2),
    valid: true,
  };
}

function trajectoryPage() {
  const base = {
    source: "runtime",
    status: "completed",
    timestamp: Date.parse("2026-08-22T12:00:00.000Z"),
  } as const;
  return {
    capture: "enabled",
    hasMore: true,
    cursor: "older-page",
    trimmedPrefix: false,
    records: [
      {
        ...base,
        id: "transcript:user-1",
        source: "transcript",
        sourceSeq: 1,
        kind: "user",
        lane: "input",
        type: "message.user",
        title: "User input",
        preview: "Inspect the deployment and explain every step.",
      },
      {
        ...base,
        id: "runtime:2",
        sourceSeq: 2,
        kind: "request",
        lane: "model",
        status: "pending",
        type: "session.started",
        runId: "run-1",
        requestId: "run-1",
        provider: "openai",
        model: "gpt-5.6-luna",
        title: "Model request",
        preview: "Preparing model request",
      },
      {
        ...base,
        id: "transcript:tool-1",
        source: "transcript",
        sourceSeq: 3,
        timestamp: Date.parse("2026-08-22T12:00:01.000Z"),
        kind: "tool",
        lane: "tools",
        type: "message.toolResult",
        toolCallId: "call-1",
        toolName: "exec",
        durationMs: 842,
        title: "exec",
        preview: "pnpm check:changed → passed",
      },
      {
        ...base,
        id: "transcript:assistant-1",
        source: "transcript",
        sourceSeq: 4,
        timestamp: Date.parse("2026-08-22T12:00:02.000Z"),
        kind: "assistant",
        lane: "model",
        type: "message.assistant",
        provider: "openai",
        model: "gpt-5.6-luna",
        title: "Assistant",
        preview: "Deployment is healthy and the checks passed.",
        usage: { input: 1200, cacheRead: 800, output: 86, reasoning: 24 },
      },
    ],
  };
}

suite.define(() => {
  it("opens the Lab-gated page type, renders its ledger, and inspects a record", async () => {
    if (proofEnabled) {
      await mkdir(proofDir, { recursive: true });
    }
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        recordVideo: proofEnabled
          ? { dir: proofDir, size: { width: 1440, height: 1000 } }
          : undefined,
        serviceWorkers: "block",
        viewport: { width: 1440, height: 1000 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: [
            "chat.metadata",
            "chat.startup",
            "config.get",
            "sessions.trajectory.detail",
            "sessions.trajectory.page",
          ],
          methodResponses: {
            "config.get": configResponse(),
            "sessions.trajectory.page": trajectoryPage(),
            "sessions.trajectory.detail": {
              ok: true,
              record: trajectoryPage().records[3],
              detail: {
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "Deployment is healthy." }],
                },
              },
            },
          },
        });

        await page.goto(`${suite.server.baseUrl}settings/labs`);
        await waitForControlUiGatewayReady(page);
        const labRow = page.locator(".settings-row").filter({ hasText: "Trajectory view" });
        await labRow.waitFor();
        expect(
          await labRow.getByRole("switch").evaluate((element) => Reflect.get(element, "checked")),
        ).toBe(true);
        if (proofEnabled) {
          await page.screenshot({ path: path.join(proofDir, "01-labs-trajectory-enabled.png") });
        }

        await page.goto(`${suite.server.baseUrl}chat`);
        await waitForControlUiGatewayReady(page);
        await openChatSidePanelType(page, "Trajectory");

        const panel = page.locator("openclaw-trajectory-panel");
        await panel.getByRole("toolbar", { name: "Trajectory controls" }).waitFor();
        await panel.getByRole("img", { name: "Trajectory timeline" }).waitFor();
        await panel.getByText("Input", { exact: true }).waitFor();
        await panel.getByText("Model", { exact: true }).waitFor();
        await panel.getByText("Tools", { exact: true }).waitFor();
        await panel.getByText("Deployment is healthy and the checks passed.").waitFor();
        expect((await gateway.getRequests("sessions.trajectory.page")).length).toBeGreaterThan(0);

        await panel.getByText("Deployment is healthy and the checks passed.").click();
        const inspector = panel.getByRole("complementary", { name: "Event details" });
        await inspector.waitFor();
        await inspector.getByRole("tab", { name: "Summary" }).waitFor();
        await inspector.getByRole("tab", { name: "Preview" }).waitFor();
        await inspector.getByText("gpt-5.6-luna").waitFor();
        expect((await gateway.getRequests("sessions.trajectory.detail")).length).toBe(1);

        if (proofEnabled) {
          await page.screenshot({ path: path.join(proofDir, "02-trajectory-ledger-detail.png") });
        }
      },
    );
  });
});
