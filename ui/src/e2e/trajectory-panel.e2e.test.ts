import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { SessionsTrajectoryPageResult, TrajectoryRecord } from "@openclaw/gateway-protocol";
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
const WHALE_RECORD_COUNT = 2_000;
const WHALE_PAGE_SIZE = 100;

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
        id: "runtime:3",
        sourceSeq: 3,
        timestamp: Date.parse("2026-08-22T12:00:01.000Z"),
        kind: "tool",
        lane: "tools",
        type: "tool.result",
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

function whaleRecord(index: number): TrajectoryRecord {
  const turn = Math.floor(index / 4) + 1;
  const timestamp = Date.parse("2026-08-22T12:00:00.000Z") + index * 250;
  const base = {
    sourceSeq: index,
    status: "completed",
    timestamp,
  } as const;
  switch (index % 4) {
    case 0:
      return {
        ...base,
        id: `transcript:whale-user-${turn}`,
        source: "transcript",
        kind: "user",
        lane: "input",
        type: "message.user",
        title: "User input",
        preview: `Mega-whale turn ${turn}: retained history probe.`,
      };
    case 1:
      return {
        ...base,
        id: `runtime:whale-request-${turn}`,
        source: "runtime",
        kind: "request",
        lane: "model",
        type: "model.call.completed",
        requestId: `request-${turn}`,
        provider: "openai",
        model: "gpt-5.6-luna",
        durationMs: 1_200 + (turn % 11) * 37,
        title: "Model response",
        preview: `Request ${turn} completed with recorded usage.`,
        usage: { input: 720, cacheRead: 480, output: 64, reasoning: 12 },
      };
    case 2:
      return {
        ...base,
        id: `runtime:whale-tool-${turn}`,
        source: "runtime",
        kind: "tool",
        lane: "tools",
        type: "tool.result",
        toolCallId: `call-${turn}`,
        toolName: "exec",
        durationMs: 300 + (turn % 13) * 19,
        title: "exec",
        preview: `whale-check --turn ${turn} → passed`,
      };
    default:
      return {
        ...base,
        id: `transcript:whale-assistant-${turn}`,
        source: "transcript",
        kind: "assistant",
        lane: "model",
        type: "message.assistant",
        provider: "openai",
        model: "gpt-5.6-luna",
        title: "Assistant",
        preview: `Mega-whale checkpoint ${turn} of 500 loaded turns (2,000 records).`,
      };
  }
}

function whalePages(): SessionsTrajectoryPageResult[] {
  const pages: SessionsTrajectoryPageResult[] = [];
  for (let end = WHALE_RECORD_COUNT; end > 0; end -= WHALE_PAGE_SIZE) {
    const start = Math.max(0, end - WHALE_PAGE_SIZE);
    pages.push({
      capture: "enabled",
      hasMore: start > 0,
      ...(start > 0 ? { cursor: `whale-before-${start}` } : {}),
      trimmedPrefix: false,
      records: Array.from({ length: end - start }, (_, offset) => whaleRecord(start + offset)),
    });
  }
  return pages;
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
              record: trajectoryPage().records[2],
              detail: {
                type: "tool.result",
                data: {
                  result: "pnpm check:changed passed all changed-surface gates",
                  isError: false,
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

        await panel.getByText("pnpm check:changed → passed").click();
        const inspector = panel.getByRole("complementary", { name: "Event details" });
        await inspector.waitFor();
        await inspector.getByRole("tab", { name: "Summary" }).waitFor();
        await inspector.getByRole("tab", { name: "Result" }).click();
        await inspector.getByText(/passed all changed-surface gates/u).waitFor();
        expect((await gateway.getRequests("sessions.trajectory.detail")).length).toBe(1);

        if (proofEnabled) {
          await page.screenshot({ path: path.join(proofDir, "02-trajectory-ledger-detail.png") });
        }
      },
    );
  });

  it("keeps a repeatedly prepended whale session anchored and virtualized", async () => {
    if (proofEnabled) {
      await mkdir(proofDir, { recursive: true });
    }
    const pages = whalePages();
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
            "sessions.trajectory.page": { sequence: pages },
            "sessions.trajectory.detail": {
              ok: true,
              record: whaleRecord(WHALE_RECORD_COUNT - 1),
              detail: {
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "Mega-whale checkpoint detail." }],
                },
              },
            },
          },
        });

        await page.goto(`${suite.server.baseUrl}chat`);
        await waitForControlUiGatewayReady(page);
        await openChatSidePanelType(page, "Trajectory");

        const panel = page.locator("openclaw-trajectory-panel");
        const ledger = panel.getByRole("table");
        await ledger.waitFor();
        expect((await gateway.getRequests("sessions.trajectory.page")).length).toBe(1);

        for (let pageIndex = 1; pageIndex < pages.length; pageIndex += 1) {
          await ledger.evaluate((element) => {
            element.scrollTop = 0;
            element.dispatchEvent(new Event("scroll"));
          });
          const currentStart = WHALE_RECORD_COUNT - pageIndex * WHALE_PAGE_SIZE;
          const anchorTurn = Math.floor(currentStart / 4) + 1;
          const anchor = panel.getByText(`Mega-whale turn ${anchorTurn}: retained history probe.`, {
            exact: true,
          });
          await anchor.waitFor();
          const before = await anchor.boundingBox();
          await panel.getByRole("button", { name: "Load earlier history" }).click();
          await expect
            .poll(async () => (await gateway.getRequests("sessions.trajectory.page")).length)
            .toBe(pageIndex + 1);
          await expect
            .poll(async () => ledger.getAttribute("aria-rowcount"))
            .toBe(String((pageIndex + 1) * 150));
          await anchor.waitFor();
          const after = await anchor.boundingBox();
          expect(before).not.toBeNull();
          expect(after).not.toBeNull();
          expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThanOrEqual(2);
        }

        await expect
          .poll(async () => panel.getByRole("button", { name: "Load earlier history" }).count())
          .toBe(0);
        expect(await ledger.getAttribute("aria-rowcount")).toBe("3000");
        expect(await panel.locator(".trajectory-ledger__virtual-row").count()).toBeLessThan(50);

        await ledger.evaluate((element) => {
          element.scrollTop = 0;
          element.dispatchEvent(new Event("scroll"));
        });
        const jumpLatest = panel.getByRole("button", { name: "Jump to latest" });
        await jumpLatest.waitFor();
        await jumpLatest.click();

        const finalCheckpoint = panel.getByText(
          "Mega-whale checkpoint 500 of 500 loaded turns (2,000 records).",
          { exact: true },
        );
        await finalCheckpoint.waitFor();
        await finalCheckpoint.click();
        const inspector = panel.getByRole("complementary", { name: "Event details" });
        await inspector.waitFor();
        await inspector.getByText("gpt-5.6-luna").waitFor();
        expect(await panel.locator(".trajectory-ledger__virtual-row").count()).toBeLessThan(50);
        expect((await gateway.getRequests("sessions.trajectory.detail")).length).toBe(1);

        if (proofEnabled) {
          await page.screenshot({ path: path.join(proofDir, "03-trajectory-mega-whale.png") });
        }
      },
    );
  });
});
