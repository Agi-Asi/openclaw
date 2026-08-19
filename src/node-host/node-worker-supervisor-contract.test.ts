import { describe, expect, it } from "vitest";
import type { NodeWorkerLaunchReceipt } from "./node-worker-launch-store.js";
import { projectNodeWorkerSupervisorReceipt } from "./node-worker-supervisor-contract.js";

function terminalReceipt(worker: NodeWorkerLaunchReceipt["worker"]): NodeWorkerLaunchReceipt {
  return {
    launchId: "launch-1",
    planHash: "a".repeat(64),
    gatewayNamespace: "gateway-1",
    environmentId: "environment-1",
    sessionId: "session-1",
    ownerEpoch: 3,
    placementGeneration: 4,
    runId: "run-1",
    state: "cancelled",
    supervisor: { pid: 1, startTime: 1 },
    worker,
    resultJson: null,
    errorText: "node worker launch cancelled",
    completedAtMs: 2,
    createdAtMs: 1,
    updatedAtMs: 2,
  };
}

describe("node worker supervisor receipt projection", () => {
  it("exposes execution readiness without exposing a worker process identity", () => {
    expect(projectNodeWorkerSupervisorReceipt(terminalReceipt(null))).toMatchObject({
      state: "cancelled",
      executionStarted: false,
    });
    expect(projectNodeWorkerSupervisorReceipt(terminalReceipt({ pid: 2, startTime: 2 }))).toMatchObject({
      state: "cancelled",
      executionStarted: true,
    });
  });
});
