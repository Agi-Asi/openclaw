// Qa Lab tests cover config-restart scenario ordering.
import { describe, expect, it } from "vitest";
import { readQaScenarioById } from "./scenario-catalog.js";

describe("QA config-restart scenario catalog", () => {
  it("uses config.apply and waits for its restart wake before restored capabilities", () => {
    const flow = JSON.stringify(readQaScenarioById("config-restart-capability-flip"));
    const wakeStartIndex = flow.indexOf('"set":"wakeStartIndex"');
    const nextConfigIndex = flow.indexOf('"set":"nextConfig"');
    const restartApplyIndex = flow.indexOf('"call":"applyConfig"');
    const applyResultIndex = flow.indexOf('"saveAs":"applyResult"', restartApplyIndex);
    const sentinelAssertIndex = flow.indexOf("applyResult.sentinel?.persisted");
    const wakeWaitIndex = flow.indexOf("candidate.text.includes(wakeMarker)");
    const wakeSinceIndex = flow.indexOf('"sinceIndex":{"ref":"wakeStartIndex"}', wakeWaitIndex);
    const settledSessionIndex = flow.indexOf("sessions.list", wakeWaitIndex);
    const idleSessionIndex = flow.indexOf("hasActiveRun", settledSessionIndex);
    const capabilityPollIndex = flow.indexOf('"saveAs":"afterTools"');
    const promptIndex = flow.indexOf('"call":"runAgentPrompt"');
    const cleanupApplyIndex = flow.lastIndexOf('"call":"applyConfig"');

    expect(wakeStartIndex).toBeGreaterThanOrEqual(0);
    expect(nextConfigIndex).toBeGreaterThan(wakeStartIndex);
    expect(restartApplyIndex).toBeGreaterThan(nextConfigIndex);
    expect(applyResultIndex).toBeGreaterThan(restartApplyIndex);
    expect(sentinelAssertIndex).toBeGreaterThan(applyResultIndex);
    expect(flow).toContain("payload?.stats?.requiresRestart === true");
    expect(wakeWaitIndex).toBeGreaterThan(sentinelAssertIndex);
    expect(wakeSinceIndex).toBeGreaterThan(wakeWaitIndex);
    expect(settledSessionIndex).toBeGreaterThan(wakeSinceIndex);
    expect(idleSessionIndex).toBeGreaterThan(settledSessionIndex);
    expect(capabilityPollIndex).toBeGreaterThan(idleSessionIndex);
    expect(promptIndex).toBeGreaterThan(capabilityPollIndex);
    expect(cleanupApplyIndex).toBeGreaterThan(promptIndex);
    expect(flow.match(/"call":"applyConfig"/g)).toHaveLength(2);
    expect(flow.match(/"call":"patchConfig"/g)).toHaveLength(1);
    expect(flow).not.toContain("restartGatewayWithConfigPatch");
    expect(flow).not.toContain("originalImageGenerationModelPrimary");
  });
});
