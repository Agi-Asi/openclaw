import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { createTestAdmittedRunContext } from "./admitted-run-context.test-support.js";
import { testing as compactionSafeguardTesting } from "./agent-hooks/compaction-safeguard.test-support.js";
import { runEmbeddedAgent } from "./embedded-agent-runner.js";
import { compactEmbeddedAgentSessionOnDemand } from "./embedded-agent-runner/compact.runtime.js";
import { withLiveCacheHeartbeat } from "./live-cache-test-support.js";
import { isLiveTestEnabled } from "./live-test-helpers.js";
import { SessionManager } from "./sessions/session-manager.js";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY?.trim() ?? "";
const describeLive =
  isLiveTestEnabled(["ANTHROPIC_LIVE_TEST"]) && ANTHROPIC_API_KEY.length > 0
    ? describe
    : describe.skip;
const MODEL_TIMEOUT_MS = 120_000;
const PRODUCTION_SHA = "c7accc6bad69dc98af8b630db52b1ad2882aeed3";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let liveRootDir: string | undefined;

type LiveAnthropicFixture = {
  apiKey: string;
  model: Model<"anthropic-messages">;
};

function resolveLiveAnthropicModel(): LiveAnthropicFixture {
  if (!ANTHROPIC_API_KEY) {
    throw new Error("missing ANTHROPIC_API_KEY");
  }
  const modelId =
    (process.env.OPENCLAW_LIVE_ANTHROPIC_CACHE_MODEL || "claude-sonnet-4-6")
      .split(/[/:]/)
      .findLast(Boolean) || "claude-sonnet-4-6";
  return {
    apiKey: ANTHROPIC_API_KEY,
    model: {
      id: modelId,
      name: modelId,
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8_192,
    },
  };
}

function buildModelDefinition(model: LiveAnthropicFixture["model"]) {
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
    api: "anthropic-messages" as const,
    reasoning: model.reasoning,
    input: ["text", "image"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
}

function buildConfig(fixture: LiveAnthropicFixture): OpenClawConfig {
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
          api: "anthropic-messages",
          auth: "api-key",
          apiKey: fixture.apiKey,
          baseUrl,
          models: [buildModelDefinition(fixture.model)],
        },
      },
    },
    agents: {
      list: [{ id: "main", default: true }],
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
  const agentDir = path.join(liveRootDir, "agents", "main", "agent");
  return {
    agentDir,
    sessionTarget: {
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      storePath: path.join(agentDir, "openclaw-agent.sqlite"),
    },
    workspaceDir: path.join(liveRootDir, `${sessionId}-workspace`),
  };
}

async function runTurn(params: {
  config: OpenClawConfig;
  fixture: LiveAnthropicFixture;
  prompt: string;
  runId: string;
  sessionId: string;
}) {
  const paths = buildSessionPaths(params.sessionId);
  await fs.mkdir(paths.agentDir, { recursive: true });
  await fs.mkdir(paths.workspaceDir, { recursive: true });
  return await withLiveCacheHeartbeat(
    runEmbeddedAgent({
      admittedRunContext: createTestAdmittedRunContext(params.runId),
      agentId: "main",
      sessionId: params.sessionId,
      sessionKey: paths.sessionTarget.sessionKey,
      sessionTarget: paths.sessionTarget,
      workspaceDir: paths.workspaceDir,
      agentDir: paths.agentDir,
      config: params.config,
      prompt: params.prompt,
      provider: params.fixture.model.provider,
      model: params.fixture.model.id,
      thinkLevel: "off",
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
  it(
    "retains audited facts in persisted and continued context at the 16K cap",
    async () => {
      liveRootDir = tempDirs.make("openclaw-pr128968-live-");
      const candidateSha = execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      const fixture = resolveLiveAnthropicModel();
      const config = buildConfig(fixture);
      const sessionId = "pr128968-retention-proof";
      const latestAsk = "preserve the pending deployment status";
      const identifier = "/tmp/compaction-final-audit.log";
      const paths = buildSessionPaths(sessionId);
      await upsertSessionEntryCore(paths.sessionTarget, {
        sessionId,
        updatedAt: Date.now(),
      });

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

      const compacted = await withLiveCacheHeartbeat(
        compactEmbeddedAgentSessionOnDemand({
          agentId: "main",
          sessionId,
          sessionKey: paths.sessionTarget.sessionKey,
          sessionTarget: paths.sessionTarget,
          workspaceDir: paths.workspaceDir,
          agentDir: paths.agentDir,
          config,
          provider: fixture.model.provider,
          model: fixture.model.id,
          thinkLevel: "off",
          force: true,
          trigger: "manual",
          runId: `${sessionId}-compact`,
          tokenBudget: 200_000,
          customInstructions: "Preserve the pending ask and exact identifier exactly.",
        }),
        "PR128968 safeguard compaction",
      );
      expect(compacted.ok).toBe(true);
      expect(compacted.compacted).toBe(true);
      const providerSummary = compacted.result?.summary ?? "";
      expect(providerSummary.toLowerCase()).toContain(latestAsk);
      expect(providerSummary).toContain(identifier);
      expect(providerSummary).toContain("## Decisions");

      const oversizedSummary = providerSummary.replace(
        "## Decisions",
        `## Decisions\n${"x".repeat(17_000)}`,
      );
      const finalized = compactionSafeguardTesting.budgetCompactionSummary(
        oversizedSummary,
        "",
        16_000,
        {
          auditSummary: oversizedSummary,
          identifiers: [identifier],
          latestAsk,
          requiredAskContext: latestAsk,
          identifierPolicy: "strict",
        },
      ) as { summary: string };
      const summary = finalized.summary;
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

      const sessionManager = SessionManager.open(paths.sessionTarget);
      const providerCompaction = sessionManager
        .getBranch()
        .findLast((entry) => entry.type === "compaction");
      if (providerCompaction?.type !== "compaction") {
        throw new Error("provider compaction was not persisted");
      }
      sessionManager.appendCompaction(
        summary,
        providerCompaction.firstKeptEntryId,
        providerCompaction.tokensBefore,
        undefined,
        true,
      );
      sessionManager.flushPendingPersistence();
      const persistedSummary = SessionManager.open(paths.sessionTarget)
        .getBranch()
        .findLast((entry) => entry.type === "compaction")?.summary;
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
        providerSummaryLength: providerSummary.length,
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
