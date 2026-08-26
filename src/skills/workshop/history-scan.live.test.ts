import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isLiveTestEnabled } from "../../agents/live-test-helpers.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import type { SkillHistoryScanPromptSession } from "./history-scan-prompt.js";
import { runSkillHistoryScanReview } from "./history-scan-review.js";
import { formatSkillHistoryScanTranscript } from "./history-scan-transcript-content.js";
import { listSkillProposals } from "./service.js";

const LIVE =
  isLiveTestEnabled(["OPENCLAW_LIVE_SKILL_HISTORY_SCAN"]) &&
  Boolean(process.env.OPENAI_API_KEY?.trim());
const describeLive = LIVE ? describe : describe.skip;
const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;
let workspaceDir = "";

function liveConfig(): OpenClawConfig {
  const modelId = process.env.OPENCLAW_LIVE_SKILL_HISTORY_MODEL ?? "gpt-5.6-luna";
  return {
    models: {
      providers: {
        openai: {
          api: "openai-responses",
          agentRuntime: { id: "openclaw" },
          apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          baseUrl: "https://api.openai.com/v1",
          models: [
            {
              id: modelId,
              name: modelId,
              api: "openai-responses",
              agentRuntime: { id: "openclaw" },
              input: ["text"],
              reasoning: true,
              contextWindow: 1_047_576,
              maxTokens: 3_000,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    },
    agents: {
      defaults: {
        model: { primary: `openai/${modelId}` },
        models: {
          [`openai/${modelId}`]: {
            agentRuntime: { id: "openclaw" },
            params: { maxTokens: 3_000 },
          },
        },
      },
      list: [{ id: "main", default: true, workspace: workspaceDir }],
    },
    skills: { workshop: { autonomous: { mode: "off" } } },
  };
}

function session(
  sessionKey: string,
  updatedAt: string,
  messages: unknown[],
): SkillHistoryScanPromptSession {
  return {
    instanceId: sessionKey,
    sessionKey,
    updatedAt,
    modelIterations: messages.filter(
      (message) =>
        message &&
        typeof message === "object" &&
        !Array.isArray(message) &&
        (message as { role?: unknown }).role === "assistant",
    ).length,
    transcript: formatSkillHistoryScanTranscript(messages, 80_000),
  };
}

function toolCall(name: string, args: Record<string, string>) {
  return { role: "assistant", content: [{ type: "toolCall", name, arguments: args }] };
}

describeLive("Skill Workshop history scan live OpenAI eval", () => {
  beforeAll(async () => {
    testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-live-skill-history-state-",
    });
    workspaceDir = await tempDirs.make("openclaw-live-skill-history-workspace-");
  });

  afterAll(async () => {
    await testState.cleanup();
    await tempDirs.cleanup();
  });

  it("clusters repeated recovery evidence and abstains from routine work", async () => {
    const recoveryOne = [
      { role: "user", content: "Deploy service alpha from this repository." },
      toolCall("deploy", { service: "alpha" }),
      { role: "toolResult", toolName: "deploy", isError: true, content: "region required" },
      toolCall("deploy", { service: "alpha", region: "us" }),
      { role: "toolResult", toolName: "deploy", isError: true, content: "health path required" },
      toolCall("read", { path: "deploy.json" }),
      { role: "toolResult", toolName: "read", content: "region=us health=/ready" },
      toolCall("deploy", { service: "alpha", region: "us", health: "/ready" }),
      { role: "toolResult", toolName: "deploy", content: "deployed" },
      toolCall("fetch", { path: "/ready" }),
      { role: "toolResult", toolName: "fetch", content: "200" },
      { role: "assistant", content: "The manifest-first preflight avoided more guessing." },
    ];
    const recoveryTwo = [
      { role: "user", content: "Deploy service beta from its checked-in configuration." },
      toolCall("deploy", { service: "beta" }),
      { role: "toolResult", toolName: "deploy", isError: true, content: "service id required" },
      toolCall("lookup", { service: "beta" }),
      { role: "toolResult", toolName: "lookup", content: "service=beta-api" },
      toolCall("deploy", { service: "beta-api" }),
      { role: "toolResult", toolName: "deploy", isError: true, content: "health path required" },
      toolCall("read", { path: "deploy.json" }),
      { role: "toolResult", toolName: "read", content: "service=beta-api health=/healthz" },
      toolCall("deploy", { service: "beta-api", health: "/healthz" }),
      { role: "toolResult", toolName: "deploy", content: "deployed" },
      toolCall("fetch", { path: "/healthz" }),
      { role: "toolResult", toolName: "fetch", content: "200" },
      { role: "assistant", content: "This again shows the manifest should be read first." },
    ];

    const embeddedAgent = await import("../../agents/embedded-agent.js");
    const runEmbeddedAgent = embeddedAgent.runEmbeddedAgent;
    const runSpy = vi
      .spyOn(embeddedAgent, "runEmbeddedAgent")
      .mockImplementation(async (params) => {
        const result = await runEmbeddedAgent(params);
        console.info(
          "[skill-history-diagnostic]",
          JSON.stringify({
            entries: params.sessionManager?.getEntries().slice(-8),
            payloads: result.payloads,
          }),
        );
        return result;
      });
    let recoveryCompletionIdeas: number | undefined;
    const ideas = await runSkillHistoryScanReview({
      agentId: "main",
      config: liveConfig(),
      onComplete: async (ideasFound) => {
        recoveryCompletionIdeas = ideasFound;
      },
      sessions: [
        session("agent:main:live-history-alpha", "2026-07-13T02:00:00.000Z", recoveryOne),
        session("agent:main:live-history-beta", "2026-07-12T02:00:00.000Z", recoveryTwo),
      ],
      workspaceDir,
    });
    runSpy.mockRestore();
    console.info("[skill-history-outcome]", JSON.stringify({ ideas, recoveryCompletionIdeas }));
    expect(ideas).toBe(1);
    expect(recoveryCompletionIdeas).toBe(1);
    const afterRecovery = await listSkillProposals({ workspaceDir });
    expect(afterRecovery.proposals).toHaveLength(1);
    expect(afterRecovery.proposals[0]).toMatchObject({ status: "pending" });

    const routine = Array.from({ length: 6 }, (_, index) => [
      { role: "assistant", content: `Reading independent receipt ${index + 1}.` },
      { role: "toolResult", toolName: "receipt", content: "valid" },
    ]).flat();
    let routineCompletionIdeas: number | undefined;
    const routineIdeas = await runSkillHistoryScanReview({
      agentId: "main",
      config: liveConfig(),
      onComplete: async (ideasFound) => {
        routineCompletionIdeas = ideasFound;
      },
      sessions: [
        session("agent:main:live-history-routine", "2026-07-11T02:00:00.000Z", [
          {
            role: "user",
            content:
              "One-time audit. These receipts are independent and policy requires one signed lookup each.",
          },
          ...routine,
          { role: "assistant", content: "All receipts are valid." },
        ]),
      ],
      workspaceDir,
    });
    expect(routineIdeas).toBe(0);
    expect(routineCompletionIdeas).toBe(0);
    expect(await listSkillProposals({ workspaceDir })).toEqual(afterRecovery);
  }, 240_000);
});
