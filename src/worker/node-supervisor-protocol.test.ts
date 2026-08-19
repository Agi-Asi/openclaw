import { describe, expect, it } from "vitest";
import {
  WORKER_PROTOCOL_FEATURES,
  WORKER_RPC_SET_VERSION,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  NODE_WORKER_CONNECTION_FAILURE_MESSAGE_TYPE,
  NODE_WORKER_EXECUTION_CONTAINER_V1,
  NODE_WORKER_EXECUTION_HOST_V1,
  nodeWorkerMemoryProjectionLaunchBinding,
  nodeWorkerPlanHash,
  parseNodeWorkerConnectionFailureMessage,
  parseNodeWorkerLaunchInput,
  parseNodeWorkerSupervisorReceipt,
  type NodeWorkerLaunchInput,
  type NodeWorkerSupervisorIdentity,
} from "./node-supervisor-protocol.js";

const RESULT_JSON_MAX_BYTES = 64 * 1024;
const ERROR_TEXT_MAX_BYTES = 4 * 1024;
const identity: NodeWorkerSupervisorIdentity = {
  launchId: "launch-1",
  planHash: "a".repeat(64),
  environmentId: "environment-1",
  sessionId: "session-1",
  ownerEpoch: 3,
  placementGeneration: 4,
  runId: "run-1",
};

function launchInput(): NodeWorkerLaunchInput {
  return {
    launchId: "turn-1",
    gatewayNamespace: "gateway-1",
    expectedBundleHash: "a".repeat(64),
    placementGeneration: 4,
    execution: { kind: NODE_WORKER_EXECUTION_HOST_V1 },
    descriptor: {
      version: 4,
      admission: {
        environmentId: "environment-1",
        credential: "worker-credential",
        sessionId: "session-1",
        ownerEpoch: 3,
        rpcSetVersion: WORKER_RPC_SET_VERSION,
        handshake: {
          bundleHash: "a".repeat(64),
          openclawVersion: "2026.8.1",
          protocolFeatures: [...WORKER_PROTOCOL_FEATURES],
        },
      },
      assignment: {
        agentId: "agent-1",
        memoryReadEnforced: false,
        operationalRunInstance: { instanceId: "instance-1", runId: "run-1" },
        agentRuntimeIdentityToken: "signed-runtime-token",
        runId: "run-1",
        turnId: "turn-1",
        prompt: "Inspect the workspace.",
        suppressPromptTranscript: true,
        workspaceDir: "/tmp/openclaw-worker/workspace",
        modelRef: { provider: "provider-1", model: "model-1" },
        inferenceOptions: {},
        initialMessages: [],
        transcript: { baseLeafId: null, nextSeq: 1 },
        liveEvents: { ackedSeq: 0, nextSeq: 1 },
        toolAuthority: { allowedToolNames: [] },
      },
    },
  };
}

function parse(input: unknown) {
  return parseNodeWorkerLaunchInput(JSON.stringify(input));
}

function memoryProjection(input: Omit<NodeWorkerLaunchInput, "memoryProjection">) {
  return {
    version: 1 as const,
    reference: "a".repeat(43),
    binding: {
      launch: nodeWorkerMemoryProjectionLaunchBinding(input),
      authorization: "b".repeat(64),
    },
    expiresAtMs: 1_900_000_000_000,
  };
}

describe("node worker supervisor wire receipt", () => {
  it("accepts only bounded worker connection diagnostics", () => {
    expect(
      parseNodeWorkerConnectionFailureMessage({
        type: NODE_WORKER_CONNECTION_FAILURE_MESSAGE_TYPE,
        cause: "certificate rejected",
      }),
    ).toEqual({
      type: NODE_WORKER_CONNECTION_FAILURE_MESSAGE_TYPE,
      cause: "certificate rejected",
    });
    expect(
      parseNodeWorkerConnectionFailureMessage({
        type: NODE_WORKER_CONNECTION_FAILURE_MESSAGE_TYPE,
        cause: null,
      }),
    ).toEqual({ type: NODE_WORKER_CONNECTION_FAILURE_MESSAGE_TYPE, cause: null });
    expect(
      parseNodeWorkerConnectionFailureMessage({
        type: NODE_WORKER_CONNECTION_FAILURE_MESSAGE_TYPE,
        cause: "x".repeat(64 * 1024 + 1),
      }),
    ).toBeNull();
  });

  it.each([
    { ...identity, state: "pending" },
    { ...identity, state: "running" },
    {
      ...identity,
      state: "completed",
      resultJson: JSON.stringify({ status: "completed", transcriptNextSeq: 2 }),
    },
    {
      ...identity,
      state: "failed",
      errorText: "worker exited before completion",
      executionStarted: false,
    },
    { ...identity, state: "interrupted", errorText: "node host stopped", executionStarted: true },
    {
      ...identity,
      state: "cancelled",
      errorText: "node worker launch cancelled",
      executionStarted: true,
    },
  ])("round-trips the closed $state receipt", (receipt) => {
    expect(parseNodeWorkerSupervisorReceipt(receipt)).toEqual(receipt);
  });

  it.each([
    { name: "extra field", receipt: { ...identity, state: "running", workerPid: 123 } },
    { name: "missing plan hash", receipt: { ...identity, planHash: undefined, state: "running" } },
    { name: "completed without output", receipt: { ...identity, state: "completed" } },
    {
      name: "completed with malformed output",
      receipt: { ...identity, state: "completed", resultJson: "{" },
    },
    {
      name: "oversized completed output",
      receipt: {
        ...identity,
        state: "completed",
        resultJson: JSON.stringify({ text: "x".repeat(RESULT_JSON_MAX_BYTES) }),
      },
    },
    { name: "failed without error", receipt: { ...identity, state: "failed" } },
    {
      name: "multiline error",
      receipt: { ...identity, state: "failed", errorText: "first\nsecond" },
    },
    {
      name: "oversized error",
      receipt: {
        ...identity,
        state: "failed",
        errorText: "x".repeat(ERROR_TEXT_MAX_BYTES + 1),
      },
    },
  ])("rejects $name", ({ receipt }) => {
    expect(parseNodeWorkerSupervisorReceipt(receipt)).toBeNull();
  });

  it("rejects non-object values without throwing", () => {
    expect(parseNodeWorkerSupervisorReceipt("{")).toBeNull();
    expect(parseNodeWorkerSupervisorReceipt(null)).toBeNull();
  });
});

describe("node worker supervisor launch protocol", () => {
  it.each([NODE_WORKER_EXECUTION_HOST_V1, NODE_WORKER_EXECUTION_CONTAINER_V1] as const)(
    "accepts the exact %s execution form",
    (kind) => {
      const input = { ...launchInput(), execution: { kind } };

      expect(parse(input).execution).toEqual({ kind });
    },
  );

  it.each([
    (input: NodeWorkerLaunchInput) => {
      const { execution: _execution, ...withoutExecution } = input;
      return withoutExecution;
    },
    (input: NodeWorkerLaunchInput) => ({ ...input, execution: { kind: "host-v2" } }),
    (input: NodeWorkerLaunchInput) => ({
      ...input,
      execution: { kind: NODE_WORKER_EXECUTION_HOST_V1, extra: true },
    }),
  ])("rejects omitted or non-closed execution", (mutate) => {
    expect(() => parse(mutate(launchInput()))).toThrow("invalid node worker");
  });

  it("includes execution in the stable launch plan hash", () => {
    const host = launchInput();
    const container = { ...host, execution: { kind: NODE_WORKER_EXECUTION_CONTAINER_V1 } as const };

    expect(nodeWorkerPlanHash(host)).not.toBe(nodeWorkerPlanHash(container));
  });

  it("binds an issued memory projection reference into the stable launch plan hash", () => {
    const base = {
      ...launchInput(),
      execution: { kind: NODE_WORKER_EXECUTION_CONTAINER_V1 } as const,
      descriptor: {
        ...launchInput().descriptor,
        assignment: { ...launchInput().descriptor.assignment, memoryReadEnforced: true },
      },
    };
    const first = { ...base, memoryProjection: memoryProjection(base) };
    const replay = {
      ...first,
      memoryProjection: {
        ...memoryProjection(base),
        reference: "b".repeat(43),
      },
    };

    expect(nodeWorkerPlanHash(first)).not.toBe(nodeWorkerPlanHash(replay));
  });

  it("fails closed when a projection is replayed into another session, agent, or placement", () => {
    const base = launchInput();
    base.execution = { kind: NODE_WORKER_EXECUTION_CONTAINER_V1 };
    base.descriptor.assignment.memoryReadEnforced = true;
    base.descriptor.assignment.workspaceDir = "/workspace";
    base.memoryProjection = memoryProjection(base);

    for (const replay of [
      {
        ...base,
        descriptor: {
          ...base.descriptor,
          admission: { ...base.descriptor.admission, sessionId: "session-2" },
        },
      },
      {
        ...base,
        descriptor: {
          ...base.descriptor,
          assignment: { ...base.descriptor.assignment, agentId: "agent-2" },
        },
      },
      { ...base, placementGeneration: base.placementGeneration + 1 },
    ]) {
      expect(() => parse(replay)).toThrow("memory projection does not match its worker launch");
    }
  });

  it("requires the fixed container root for enforced memory launches", () => {
    const input = launchInput();
    input.execution = { kind: NODE_WORKER_EXECUTION_CONTAINER_V1 };
    input.descriptor.assignment.memoryReadEnforced = true;
    input.memoryProjection = memoryProjection(input);

    expect(() => parse(input)).toThrow("must use the /workspace root");

    input.descriptor.assignment.workspaceDir = "/workspace";
    expect(parse(input).descriptor.assignment.workspaceDir).toBe("/workspace");
  });

  it("rejects enforced memory when an untrusted node tries to downgrade execution to host-v1", () => {
    const input = launchInput();
    input.descriptor.assignment.memoryReadEnforced = true;
    input.memoryProjection = memoryProjection(input);

    expect(() => parse(input)).toThrow("requires container-v1 execution");
  });

  it("checks the containment root only when the paired permission context is present", () => {
    const input = launchInput();
    input.execution = { kind: NODE_WORKER_EXECUTION_CONTAINER_V1 };
    input.descriptor.assignment.memoryReadEnforced = true;
    input.memoryProjection = memoryProjection(input);
    input.descriptor.assignment.workspaceDir = "/workspace";
    input.descriptor.assignment = {
      ...input.descriptor.assignment,
      permissionMode: "workspace",
      workerContainmentRoot: "/host/workspace",
    };

    expect(() => parse(input)).toThrow("must use the /workspace root");

    input.descriptor.assignment = {
      ...input.descriptor.assignment,
      workerContainmentRoot: "/workspace",
    };
    expect(parse(input).descriptor.assignment.workerContainmentRoot).toBe("/workspace");
  });
});
