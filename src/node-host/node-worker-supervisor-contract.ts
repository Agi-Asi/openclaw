import {
  parseNodeWorkerSupervisorReceipt,
  type NodeWorkerLaunchInput,
  type NodeWorkerSupervisorIdentity,
  type NodeWorkerSupervisorReceipt,
} from "../worker/node-supervisor-protocol.js";
import type {
  NodeWorkerWorkspaceRetainInput,
  NodeWorkerWorkspaceRetainResult,
} from "../worker/node-workspace-retain-protocol.js";
import type { WorkerConnectionEndpoint } from "../worker/worker-connection-endpoint.js";
import type { NodeWorkerLaunchReceipt } from "./node-worker-launch-store.js";

export {
  NODE_WORKER_EXECUTION_CONTAINER_V1,
  NODE_WORKER_EXECUTION_HOST_V1,
  nodeWorkerMemoryProjectionLaunchBinding,
  nodeWorkerPlanHash,
  parseNodeWorkerCancelInput,
  parseNodeWorkerLaunchInput,
  parseNodeWorkerLookupInput,
} from "../worker/node-supervisor-protocol.js";
export type {
  NodeWorkerExecution,
  NodeWorkerLaunchInput,
  NodeWorkerSupervisorIdentity,
  NodeWorkerSupervisorReceipt,
} from "../worker/node-supervisor-protocol.js";

export type NodeWorkerSupervisorControl = {
  launch(
    input: NodeWorkerLaunchInput,
    connectionEndpoint: WorkerConnectionEndpoint,
    signal?: AbortSignal,
  ): Promise<NodeWorkerLaunchReceipt>;
  status(launchId: string): Promise<NodeWorkerLaunchReceipt | undefined>;
  retainWorkspaces(
    input: NodeWorkerWorkspaceRetainInput,
    signal?: AbortSignal,
  ): Promise<NodeWorkerWorkspaceRetainResult>;
  cancel(expected: NodeWorkerSupervisorIdentity): Promise<NodeWorkerLaunchReceipt | undefined>;
};

export function projectNodeWorkerSupervisorReceipt(
  receipt: NodeWorkerLaunchReceipt,
): NodeWorkerSupervisorReceipt {
  const identity = {
    launchId: receipt.launchId,
    planHash: receipt.planHash,
    environmentId: receipt.environmentId,
    sessionId: receipt.sessionId,
    ownerEpoch: receipt.ownerEpoch,
    placementGeneration: receipt.placementGeneration,
    runId: receipt.runId,
  };
  const projected =
    receipt.state === "completed"
      ? { ...identity, state: receipt.state, resultJson: receipt.resultJson }
      : receipt.state === "failed" ||
          receipt.state === "interrupted" ||
          receipt.state === "cancelled"
        ? {
            ...identity,
            state: receipt.state,
            errorText: receipt.errorText,
            // Worker identity is persisted only by markRunning, after the private child
            // acknowledgement. Do not expose the PID, only the durable execution fact.
            executionStarted: receipt.worker !== null,
          }
        : { ...identity, state: receipt.state };
  const parsed = parseNodeWorkerSupervisorReceipt(projected);
  if (!parsed) {
    throw new Error("node worker supervisor durable receipt is inconsistent");
  }
  return parsed;
}
