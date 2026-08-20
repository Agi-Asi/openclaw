// Qa Lab tests cover config-restart scenario ordering.
import { describe, expect, it } from "vitest";
import { readQaScenarioById } from "./scenario-catalog.js";

describe("QA config-restart scenario catalog", () => {
  it("waits for the restart wake before using restored capabilities", () => {
    const flow = JSON.stringify(readQaScenarioById("config-restart-capability-flip"));
    const originalTerminalIndex = flow.indexOf('"set":"originalGatewayTerminalEnabled"');
    const restartOwnedMutationIndex = flow.indexOf(
      '"gateway":{"terminal":{"enabled":{"expr":"originalGatewayTerminalEnabled === false"}}}',
    );
    const restartPatchIndex = flow.indexOf('"note":{"ref":"wakeMarker"}');
    const wakeWaitIndex = flow.indexOf("candidate.text.includes(wakeMarker)");
    const capabilityPollIndex = flow.indexOf('"saveAs":"afterTools"');
    const cleanupIndex = flow.indexOf(
      '"gateway":{"terminal":{"enabled":{"expr":"originalGatewayTerminalEnabled === undefined ? null : originalGatewayTerminalEnabled"}}}',
    );

    expect(originalTerminalIndex).toBeGreaterThanOrEqual(0);
    expect(restartOwnedMutationIndex).toBeGreaterThan(originalTerminalIndex);
    expect(restartPatchIndex).toBeGreaterThan(restartOwnedMutationIndex);
    expect(wakeWaitIndex).toBeGreaterThan(restartPatchIndex);
    expect(capabilityPollIndex).toBeGreaterThan(wakeWaitIndex);
    expect(flow.indexOf('"call":"runAgentPrompt"')).toBeGreaterThan(capabilityPollIndex);
    expect(cleanupIndex).toBeGreaterThan(flow.indexOf('"finally":'));
  });
});
