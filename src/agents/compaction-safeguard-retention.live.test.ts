import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createTestAdmittedRunContext } from "./admitted-run-context.test-support.js";
import { runEmbeddedAgent } from "./embedded-agent-runner.js";
import { compactEmbeddedAgentSessionOnDemand } from "./embedded-agent-runner/compact.runtime.js";
import {
  resolveLiveDirectModel,
  withLiveCacheHeartbeat,
  type LiveResolvedModel,
} from "./live-cache-test-support.js";
import { isLiveTestEnabled } from "./live-test-helpers.js";

const describeLive = isLiveTestEnabled() ? describe : describe.skip;
const MODEL_TIMEOUT_MS = 120_000;
const PRODUCTION_SHA = "c7accc6bad69dc98af8b630db52b1ad2882aeed3";
let liveRootDir: string | undefined;

function resolveModelApi(model: LiveResolvedModel["model"]): "anthropic-messages" {
  if (model.provider !== "anthropic") {
    throw new Error(`expected Anthropic model, received ${model.provider}`);
  }
  return "anthropic-messages";
}

function buildModelDefinition(model: LiveResolvedModel["model"]) {
  const contextWindow =
    typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow)
      ? Math.max(1, Math.trunc(model.contextWindow))
      : 128_000;
  const maxTokens =
    typeof model.maxTokens === "number" && Number.isFinite(model.maxTokens)
      ? Math.max(1, Math.trunc(model.maxTokens))
      : 8_192;
  return {
    id: model.id,
    name: model.id,
    api: resolveModelApi(model),
    reasoning: model.reasoning,
    input: ["text", "image"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
}

function buildConfig(fixture: LiveResolvedModel): OpenClawConfig {
  const provider = fixture.model.provider;
  const modelKey = `${provider}/${fixture.model.id}`;
  const baseUrl =
    typeof fixture.model.baseUrl === "string" && fixture.model.baseUrl.trim().length > 0
      ? fixture.model.baseUrl
      : "https://api.anthropic.com/v1";
  return {
    models: {
      providers: {
        [provider]: {
          api: resolveModelApi(fixture.model),
          auth: "api-key",
          apiKey: fixture.apiKey,
          baseUrl,
          models: [buildModelDefinition(fixture.model)],
        },
      },
    },
    agents: {
      defaults: {
        models: {
          [modelKey]: {
            alias: "live-compaction",
            params: { cacheRetention: "short" },
          },
        },
        compaction: {
          model: "live-compaction",
          mode: "safeguard",
          keepRecentTokens: 1,
          recentTurnsPreserve: 0,
          identifierPolicy: "strict",
          qualityGuard: { enabled: true, maxRetries: 0 },
        },
      },
    },
  };
}

function buildSessionPaths(sessionId: string) {
  if (!liveRootDir) {
    throw new Error("live proof root is not initialized");
  }
  return {
    agentDir: liveRootDir,
    sessionFile: path.join(liveRootDir, `${sessionId}.jsonl`),
    workspaceDir: path.join(liveRootDir, `${sessionId}-workspace`),
  };
}

async function runTurn(params: {
  config: OpenClawConfig;
  fixture: LiveResolvedModel;
  prompt: string;
  runId: string;
  sessionId: string;
}) {
  const paths = buildSessionPaths(params.sessionId);
  await fs.mkdir(paths.workspaceDir, { recursive: true });
  return await withLiveCacheHeartbeat(
    runEmbeddedAgent({
      admittedRunContext: createTestAdmittedRunContext(params.runId),
      sessionId: params.sessionId,
      sessionKey: `live-proof:anthropic:${params.sessionId}`,
      sessionFile: paths.sessionFile,
      workspaceDir: paths.workspaceDir,
      agentDir: paths.agentDir,
      config: params.config,
      prompt: params.prompt,
      provider: params.fixture.model.provider,
      model: params.fixture.model.id,
      timeoutMs: MODEL_TIMEOUT_MS,
      runId: params.runId,
      disableTools: true,
      cleanupBundleMcpOnRunEnd: true,
    }),
    `PR128968 ${params.runId}`,
  );
}

function extractPayloadText(payloads: Array<{ text?: string } | undefined> | undefined): string {
  return (
    payloads
      ?.map((payload) => payload?.text?.trim())
      .filter((text): text is string => Boolean(text))
      .join(" ") ?? ""
  );
}

describeLive("compaction safeguard retention proof (live)", () => {
  beforeAll(async () => {
    liveRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pr128968-live-"));
  });

  afterAll(async () => {
    if (liveRootDir) {
      await fs.rm(liveRootDir, { recursive: true, force: true });
    }
  });

  it(
    "retains audited facts in persisted and continued context at the 16K cap",
    async () => {
      const candidateSha = execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      const fixture = await resolveLiveDirectModel({
        provider: "anthropic",
        api: "anthropic-messages",
        envVar: "OPENCLAW_LIVE_ANTHROPIC_MODEL",
        preferredModelIds: ["claude-sonnet-4-6", "claude-sonnet-4-5"],
      });
      const config = buildConfig(fixture);
      const sessionId = "pr128968-retention-proof";
      const latestAsk = "preserve the pending deployment status";
      const identifier = "/tmp/compaction-final-audit.log";

      const primeSections = Array.from(
        { length: 96 },
        (_, index) =>
          `History section ${index + 1}: deterministic context about rollout checks, audit state, and session continuity.`,
      ).join("\n");
      await runTurn({
        config,
        fixture,
        prompt: `Reply with exactly HISTORY-PRIMED.\n${primeSections}`,
        runId: `${sessionId}-prime`,
        sessionId,
      });
      await runTurn({
        config,
        fixture,
        prompt: `${latestAsk}. Keep this exact identifier: ${identifier}.`,
        runId: `${sessionId}-facts`,
        sessionId,
      });

      const paths = buildSessionPaths(sessionId);
      const compacted = await withLiveCacheHeartbeat(
        compactEmbeddedAgentSessionOnDemand({
          sessionId,
          sessionKey: `live-proof:anthropic:${sessionId}`,
          sessionFile: paths.sessionFile,
          workspaceDir: paths.workspaceDir,
          agentDir: paths.agentDir,
          config,
          provider: fixture.model.provider,
          model: fixture.model.id,
          force: true,
          trigger: "manual",
          runId: `${sessionId}-compact`,
          tokenBudget: 200_000,
          customInstructions:
            "Put at least 17000 lowercase x characters in ## Decisions before all other required sections. Preserve the pending ask and exact identifier exactly.",
        }),
        "PR128968 safeguard compaction",
      );
      expect(compacted.ok).toBe(true);
      expect(compacted.compacted).toBe(true);
      const summary = compacted.result?.summary ?? "";
      expect(summary.length).toBeLessThanOrEqual(16_000);
      expect(summary).toContain("[Compaction summary truncated to fit budget]");

      const headings = [
        "## Decisions",
        "## Open TODOs",
        "## Constraints/Rules",
        "## Pending user asks",
        "## Exact identifiers",
      ];
      let headingCursor = -1;
      for (const heading of headings) {
        const next = summary.indexOf(heading, headingCursor + 1);
        expect(next).toBeGreaterThan(headingCursor);
        headingCursor = next;
      }
      expect(summary).toContain(latestAsk);
      expect(summary).toContain(identifier);

      const persistedRows = (await fs.readFile(paths.sessionFile, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type?: string; summary?: string });
      const persistedSummary = persistedRows.findLast((row) => row.type === "compaction")?.summary;
      expect(persistedSummary).toBe(summary);

      const followup = await runTurn({
        config,
        fixture,
        prompt: `Reply with exactly RETENTION-OK if the compacted context contains both ${latestAsk} and ${identifier}.`,
        runId: `${sessionId}-followup`,
        sessionId,
      });
      const followupText = extractPayloadText(followup.payloads);
      expect(followupText).toContain("RETENTION-OK");

      const evidence = {
        productionSha: PRODUCTION_SHA,
        candidateSha,
        model: `${fixture.model.provider}/${fixture.model.id}`,
        summaryLength: summary.length,
        capped: summary.length <= 16_000,
        truncationMarker: summary.includes("[Compaction summary truncated to fit budget]"),
        headingsOrdered: true,
        latestAskRetained: summary.includes(latestAsk),
        identifierRetained: summary.includes(identifier),
        persistedMatchesReturned: persistedSummary === summary,
        followupRecall: followupText.includes("RETENTION-OK"),
      };
      console.log(`PR128968_EVIDENCE ${JSON.stringify(evidence)}`);
    },
    15 * 60_000,
  );
});
