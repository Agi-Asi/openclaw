import type { MemoryBrokerAuthorizationBinding } from "openclaw/plugin-sdk/memory-broker-runtime";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  export: vi.fn(),
  import: vi.fn(),
  read: vi.fn(),
  recoverPendingWrites: vi.fn(),
  search: vi.fn(),
  status: vi.fn(),
  sync: vi.fn(),
  virtualFile: vi.fn(),
  virtualView: vi.fn(),
  write: vi.fn(),
}));

vi.mock("./scoped-memory-runtime.js", () => ({
  builtinScopedMemoryAuthorizedRuntime: {
    authorize: mocks.authorize,
    exportAuthorized: mocks.export,
    importAuthorized: mocks.import,
    readAuthorized: mocks.read,
    searchAuthorized: mocks.search,
    statusAuthorized: mocks.status,
    syncAuthorized: mocks.sync,
    writeAuthorized: mocks.write,
  },
  builtinScopedMemoryVirtualView: {
    materializeAuthorizedVirtualView: mocks.virtualView,
    readAuthorizedVirtualFile: mocks.virtualFile,
  },
  recoverBuiltinScopedMemoryPendingWrites: mocks.recoverPendingWrites,
}));

const { createMemoryBrokerHandler, initializeMemoryBroker } = await import("./broker-entry.js");

const binding: MemoryBrokerAuthorizationBinding = {
  agentId: "agent-a",
  sessionId: "session-a",
  runId: "run-a",
  contextFingerprint: "context-a",
  subjectRevision: "subject-a",
  actor: { kind: "principal", actorKind: "human", principalId: "alice" },
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
  actor: {
    kind: binding.actor.kind,
    actorKind: binding.actor.actorKind,
    principalId: binding.actor.principalId,
    evidenceRevision: binding.actorRevision,
  },
  delivery: { deliveryRevision: binding.deliveryRevision },
  hostFactsRevision: binding.policyRevision,
};

describe("memory-core broker entry", () => {
  it("recovers only the configured agent set before the broker exposes its socket", () => {
    mocks.recoverPendingWrites.mockClear();

    initializeMemoryBroker({ agentIds: ["main", "work"] });

    expect(mocks.recoverPendingWrites).toHaveBeenCalledWith(["main", "work"]);
  });

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

  it("rejects an actor principal substitution that keeps the same evidence revision", async () => {
    const handler = createMemoryBrokerHandler();

    await expect(
      handler({
        binding,
        request: {
          method: "memory.authorize",
          payload: {
            context: { ...context, actor: { ...context.actor, principalId: "bob" } },
          },
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("memory broker binding is unavailable");
    expect(mocks.authorize).not.toHaveBeenCalled();
  });

  it("dispatches a bound operation only after its plan policy revision matches", async () => {
    const handler = createMemoryBrokerHandler();
    const controller = new AbortController();
    const plan = { memoryPolicyRevision: binding.policyRevision };
    mocks.status.mockResolvedValue({ version: 1, value: { backend: "builtin" } });

    await expect(
      handler({
        binding,
        request: {
          method: "memory.status",
          payload: { context, plan },
        },
        signal: controller.signal,
      }),
    ).resolves.toEqual({ version: 1, value: { backend: "builtin" } });
    expect(mocks.status).toHaveBeenCalledWith({ context, plan, signal: controller.signal });
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

  it("omits unrecognized search sources before selected-runtime dispatch", async () => {
    const handler = createMemoryBrokerHandler();
    const plan = { memoryPolicyRevision: binding.policyRevision };
    const searchContext = { ...context, operation: "read" as const };
    mocks.search.mockResolvedValue({ version: 1, value: { results: [] } });

    await handler({
      binding,
      request: {
        method: "memory.search",
        payload: {
          context: searchContext,
          plan,
          query: "Alice",
          limit: 5,
          sources: ["memory", "untrusted-source"],
        },
      },
      signal: new AbortController().signal,
    });

    expect(mocks.search).toHaveBeenCalledWith(
      expect.objectContaining({ context: searchContext, plan, query: "Alice", limit: 5 }),
    );
    expect(mocks.search.mock.calls.at(-1)?.[0]).not.toHaveProperty("sources");
  });

  it("forwards the broker cancellation signal into every authorized operation", async () => {
    const handler = createMemoryBrokerHandler();
    const controller = new AbortController();
    const plan = { memoryPolicyRevision: binding.policyRevision };
    const readContext = { ...context, operation: "read" as const };
    const writeContext = { ...context, operation: "append" as const };
    mocks.read.mockResolvedValue({ version: 1, value: { text: "ok" } });
    mocks.virtualView.mockResolvedValue({ version: 1, files: [] });
    mocks.virtualFile.mockResolvedValue({ version: 1, value: { text: "ok" } });
    mocks.write.mockResolvedValue({ status: "committed" });
    mocks.import.mockResolvedValue({ status: "committed" });
    mocks.sync.mockResolvedValue({ version: 1, value: { status: "completed" } });
    mocks.export.mockResolvedValue({ version: 1, value: {} });

    await Promise.all([
      handler({
        binding,
        request: { method: "memory.read", payload: { context: readContext, plan, handle: {} } },
        signal: controller.signal,
      }),
      handler({
        binding,
        request: { method: "memory.virtual-view", payload: { context: readContext, plan } },
        signal: controller.signal,
      }),
      handler({
        binding,
        request: {
          method: "memory.virtual-file",
          payload: { context: readContext, plan, view: {}, virtualPath: "private/1.md" },
        },
        signal: controller.signal,
      }),
      handler({
        binding,
        request: { method: "memory.write", payload: { context: writeContext, plan, mutation: {} } },
        signal: controller.signal,
      }),
      handler({
        binding,
        request: {
          method: "memory.import",
          payload: { context: writeContext, plan, mutation: { kind: "import" } },
        },
        signal: controller.signal,
      }),
      handler({
        binding,
        request: { method: "memory.sync", payload: { context: writeContext, plan } },
        signal: controller.signal,
      }),
      handler({
        binding,
        request: { method: "memory.export", payload: { context: writeContext, plan, handles: [] } },
        signal: controller.signal,
      }),
    ]);

    for (const operation of [
      mocks.read,
      mocks.virtualView,
      mocks.virtualFile,
      mocks.write,
      mocks.import,
      mocks.sync,
      mocks.export,
    ]) {
      expect(operation).toHaveBeenCalledWith(
        expect.objectContaining({ signal: controller.signal }),
      );
    }
  });
});
