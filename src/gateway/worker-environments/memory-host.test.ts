import { afterEach, describe, expect, it } from "vitest";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import {
  clearWorkerMemoryHostsForTest,
  registerWorkerMemoryHost,
  resolveWorkerMemoryHost,
} from "./memory-host.js";

const identity: WorkerConnectionIdentity = {
  environmentId: "environment-a",
  credentialHash: "credential-a",
  bundleHash: "a".repeat(64),
  sessionId: "session-a",
  runId: "run-a",
  ownerEpoch: 1,
  rpcSetVersion: 1,
  protocolFeatures: [],
  credentialExpiresAtMs: Date.now() + 60_000,
};

afterEach(() => clearWorkerMemoryHostsForTest());

describe("worker memory host registry", () => {
  it("resolves only the exact Gateway-registered worker turn and retires it with the turn", () => {
    const host = {
      search: async () => ({ results: [] }),
      read: async () => ({ text: "", path: "" }),
    };
    const registration = { host, allowedToolNames: ["memory_search"] as const };
    const unregister = registerWorkerMemoryHost(identity, registration);

    expect(resolveWorkerMemoryHost(identity)).toBe(registration);
    expect(resolveWorkerMemoryHost({ ...identity, runId: "run-b" })).toBeUndefined();
    expect(resolveWorkerMemoryHost({ ...identity, ownerEpoch: 2 })).toBeUndefined();
    expect(resolveWorkerMemoryHost({ ...identity, sessionId: null, runId: null })).toBeUndefined();

    unregister();
    expect(resolveWorkerMemoryHost(identity)).toBeUndefined();
  });
});
