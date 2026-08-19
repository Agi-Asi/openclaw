import { describe, expect, it } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../packages/gateway-protocol/src/client-info.js";
import {
  NODE_WORKER_EXECUTION_CONTAINER_V1,
  NODE_WORKER_EXECUTION_HOST_V1,
} from "../worker/node-supervisor-protocol.js";
import {
  NODE_WORKER_SUPERVISOR_PROCESS_ISOLATION_PROTOCOL_FEATURE,
  NODE_WORKER_SUPERVISOR_MEMORY_PROJECTION_PROTOCOL_FEATURE,
  NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
  parseNodeRunnerInventoryDeclaration,
} from "./node-runner-inventory.js";
import {
  supportsNodeWorkerExecution,
  type NodeWorkerSupervisorNodeProof,
} from "../gateway/node-runner-inventory-runtime.js";

const capacity = { total: 2, available: 2 } as const;

function proof(params: {
  protocolFeature:
    | typeof NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE
    | typeof NODE_WORKER_SUPERVISOR_PROCESS_ISOLATION_PROTOCOL_FEATURE
    | typeof NODE_WORKER_SUPERVISOR_MEMORY_PROJECTION_PROTOCOL_FEATURE;
  processIsolation?: {
    kind: typeof NODE_WORKER_EXECUTION_CONTAINER_V1;
    memoryProjection?: 1;
  };
}): NodeWorkerSupervisorNodeProof {
  return {
    nodeId: "node-1",
    connId: "conn-1",
    pairingIdentity: "identity-1",
    pairingGeneration: "generation-1",
    clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
    clientMode: "node",
    protocolFeature: params.protocolFeature,
    workerHost: {
      enabled: true,
      capacity,
      ...(params.processIsolation ? { processIsolation: params.processIsolation } : {}),
    },
    commands: ["system.run"],
  };
}

describe("node runner process-isolation inventory", () => {
  it("keeps v5 host-only and accepts only the exact v6 declaration", () => {
    const v5 = {
      protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
      workerHost: { enabled: true, capacity },
    };
    const v6 = {
      protocolFeatures: [NODE_WORKER_SUPERVISOR_PROCESS_ISOLATION_PROTOCOL_FEATURE],
      workerHost: {
        enabled: true,
        capacity,
        processIsolation: { kind: NODE_WORKER_EXECUTION_CONTAINER_V1 },
      },
    };

    expect(parseNodeRunnerInventoryDeclaration(v5)).toEqual(v5);
    expect(parseNodeRunnerInventoryDeclaration(v6)).toEqual(v6);
    expect(
      parseNodeRunnerInventoryDeclaration({
        ...v5,
        workerHost: { ...v5.workerHost, processIsolation: v6.workerHost.processIsolation },
      }),
    ).toBeNull();
  });

  it.each([
    {
      protocolFeatures: [NODE_WORKER_SUPERVISOR_PROCESS_ISOLATION_PROTOCOL_FEATURE],
      workerHost: { enabled: true, capacity },
    },
    {
      protocolFeatures: [NODE_WORKER_SUPERVISOR_PROCESS_ISOLATION_PROTOCOL_FEATURE],
      workerHost: { enabled: false },
    },
    {
      protocolFeatures: [NODE_WORKER_SUPERVISOR_PROCESS_ISOLATION_PROTOCOL_FEATURE],
      workerHost: {
        enabled: true,
        capacity,
        processIsolation: { kind: NODE_WORKER_EXECUTION_CONTAINER_V1, extra: true },
      },
    },
    {
      protocolFeatures: [NODE_WORKER_SUPERVISOR_PROCESS_ISOLATION_PROTOCOL_FEATURE],
      workerHost: { enabled: true, capacity, processIsolation: { kind: "host-v1" } },
    },
  ])("rejects malformed v6 process-isolation declarations", (declaration) => {
    expect(parseNodeRunnerInventoryDeclaration(declaration)).toBeNull();
  });

  it("admits container execution only for the exact v7 memory-projection proof", () => {
    const v5 = proof({ protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE });
    const v6 = proof({
      protocolFeature: NODE_WORKER_SUPERVISOR_PROCESS_ISOLATION_PROTOCOL_FEATURE,
      processIsolation: { kind: NODE_WORKER_EXECUTION_CONTAINER_V1 },
    });
    const v7 = proof({
      protocolFeature: NODE_WORKER_SUPERVISOR_MEMORY_PROJECTION_PROTOCOL_FEATURE,
      processIsolation: { kind: NODE_WORKER_EXECUTION_CONTAINER_V1, memoryProjection: 1 },
    });

    expect(supportsNodeWorkerExecution(v5, { kind: NODE_WORKER_EXECUTION_HOST_V1 })).toBe(true);
    expect(supportsNodeWorkerExecution(v5, { kind: NODE_WORKER_EXECUTION_CONTAINER_V1 })).toBe(
      false,
    );
    expect(supportsNodeWorkerExecution(v6, { kind: NODE_WORKER_EXECUTION_CONTAINER_V1 })).toBe(
      false,
    );
    expect(supportsNodeWorkerExecution(v7, { kind: NODE_WORKER_EXECUTION_CONTAINER_V1 })).toBe(
      true,
    );
  });
});
