import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  search: vi.fn(),
  status: vi.fn(),
}));

vi.mock("./scoped-memory-runtime.js", () => ({
  builtinScopedMemoryAuthorizedRuntime: {
    authorize: mocks.authorize,
    searchAuthorized: mocks.search,
    statusAuthorized: mocks.status,
  },
  builtinScopedMemoryVirtualView: {},
}));

const { createMemoryBrokerHandler } = await import("./broker-entry.js");

const binding = {
  agentId: "agent-a",
  sessionId: "session-a",
  runId: "run-a",
  contextFingerprint: "context-a",
  subjectRevision: "subject-a",
  actorRevision: "actor-a",
  // Without a delegation, Gateway uses hostFactsRevision for the capability snapshot.
  capabilitySnapshotId: "policy-a",
  policyRevision: "policy-a",
  deliveryRevision: "delivery-a",
};

const context = {
  agentId: binding.agentId,
  sessionId: binding.sessionId,
  runId: binding.runId,
  contextFingerprint: binding.contextFingerprint,
  subjectRevision: binding.subjectRevision,
  actor: { evidenceRevision: binding.actorRevision },
  delivery: { deliveryRevision: binding.deliveryRevision },
  hostFactsRevision: binding.policyRevision,
};

describe("memory-core broker entry", () => {
  it("rejects a client-provided context that does not exactly match the Gateway binding", async () => {
    const handler = createMemoryBrokerHandler();

    await expect(
      handler({
        binding,
        request: {
          method: "memory.authorize",
          payload: { context: { ...context, agentId: "agent-b" } },
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("memory broker binding is unavailable");
    expect(mocks.authorize).not.toHaveBeenCalled();
  });

  it("dispatches a bound operation only after its plan policy revision matches", async () => {
    const handler = createMemoryBrokerHandler();
    const plan = { memoryPolicyRevision: binding.policyRevision };
    mocks.status.mockResolvedValue({ version: 1, value: { backend: "builtin" } });

    await expect(
      handler({
        binding,
        request: {
          method: "memory.status",
          payload: { context, plan },
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ version: 1, value: { backend: "builtin" } });
    expect(mocks.status).toHaveBeenCalledWith({ context, plan });
  });

  it("forwards the broker cancellation signal into content search", async () => {
    const handler = createMemoryBrokerHandler();
    const controller = new AbortController();
    const plan = { memoryPolicyRevision: binding.policyRevision };
    const searchContext = { ...context, operation: "read" as const };
    mocks.search.mockResolvedValue({ version: 1, value: { results: [] } });

    await expect(
      handler({
        binding,
        request: {
          method: "memory.search",
          payload: { context: searchContext, plan, query: "Alice", limit: 5 },
        },
        signal: controller.signal,
      }),
    ).resolves.toEqual({ version: 1, value: { results: [] } });
    expect(mocks.search).toHaveBeenCalledWith({
      context: searchContext,
      plan,
      query: "Alice",
      limit: 5,
      signal: controller.signal,
    });
  });
});
