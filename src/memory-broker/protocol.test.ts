import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createMemoryBrokerEnvelope,
  MemoryBrokerNonceLedger,
  verifyMemoryBrokerEnvelope,
  type MemoryBrokerAuthorizationBinding,
  type MemoryBrokerRequest,
} from "./protocol.js";

const secret = randomBytes(32);
const binding: MemoryBrokerAuthorizationBinding = {
  agentId: "agent-a",
  sessionId: "session-a",
  runId: "run-a",
  contextFingerprint: "context-a",
  subjectRevision: "subject-a",
  actor: { kind: "principal", actorKind: "human", principalId: "alice" },
  actorRevision: "actor-a",
  capabilitySnapshotId: "capability-a",
  policyRevision: "policy-a",
  deliveryRevision: "delivery-a",
};
const request: MemoryBrokerRequest = {
  method: "memory.search",
  payload: { limit: 10, query: "private note" },
};

function createEnvelope(overrides: Partial<Parameters<typeof createMemoryBrokerEnvelope>[0]> = {}) {
  const envelope = createMemoryBrokerEnvelope({
    secret,
    brokerId: "broker-a",
    brokerEpoch: "epoch-a",
    binding,
    nonce: "nonce-a",
    request,
    issuedAtMs: 1_000,
    expiresAtMs: 2_000,
    ...overrides,
  });
  expect(envelope).toBeDefined();
  return envelope!;
}

function verify(
  envelope: unknown,
  overrides: Partial<Parameters<typeof verifyMemoryBrokerEnvelope>[0]> = {},
) {
  return verifyMemoryBrokerEnvelope({
    secret,
    brokerId: "broker-a",
    brokerEpoch: "epoch-a",
    expectedBinding: binding,
    envelope,
    request,
    nowMs: 1_500,
    ...overrides,
  });
}

describe("memory broker envelope", () => {
  it("refuses a request whose canonical form exceeds the nesting budget", () => {
    let payload: unknown = "leaf";
    for (let depth = 0; depth < 65; depth += 1) {
      payload = [payload];
    }

    expect(
      createMemoryBrokerEnvelope({
        secret,
        brokerId: "broker-a",
        brokerEpoch: "epoch-a",
        binding,
        nonce: "nested-request",
        request: { method: "memory.search", payload },
        issuedAtMs: 1_000,
        expiresAtMs: 2_000,
      }),
    ).toBeUndefined();
  });

  it("binds a deterministic request and every Gateway-derived authorization revision", () => {
    const envelope = createEnvelope();
    expect(verify(envelope)).toEqual({ ok: true });
    expect(
      verify(envelope, {
        request: { method: "memory.search", payload: { query: "another store", limit: 10 } },
      }),
    ).toEqual({ ok: false, reason: "request-mismatch" });
    for (const [field, replacement] of [
      ["agentId", "agent-b"],
      ["sessionId", "session-b"],
      ["runId", "run-b"],
      ["contextFingerprint", "context-b"],
      ["subjectRevision", "subject-b"],
      ["actorRevision", "actor-b"],
      ["capabilitySnapshotId", "capability-b"],
      ["policyRevision", "policy-b"],
      ["deliveryRevision", "delivery-b"],
    ] as const) {
      expect(
        verify(envelope, {
          expectedBinding: { ...binding, [field]: replacement },
        }),
      ).toEqual({ ok: false, reason: "binding-mismatch" });
    }
    expect(
      verify(envelope, {
        expectedBinding: { ...binding, actor: { ...binding.actor, principalId: "bob" } },
      }),
    ).toEqual({ ok: false, reason: "binding-mismatch" });
    expect(
      verify(envelope, {
        expectedBinding: { ...binding, actor: { ...binding.actor, actorKind: "service" } },
      }),
    ).toEqual({ ok: false, reason: "binding-mismatch" });
  });

  it("rejects cross-broker, stale-epoch, expired, and forged envelopes", () => {
    const envelope = createEnvelope();
    expect(verify(envelope, { brokerId: "broker-b" })).toEqual({
      ok: false,
      reason: "broker-mismatch",
    });
    expect(verify(envelope, { brokerEpoch: "epoch-b" })).toEqual({
      ok: false,
      reason: "epoch-mismatch",
    });
    expect(verify(envelope, { nowMs: 2_000 })).toEqual({ ok: false, reason: "expired" });
    expect(verify({ ...envelope, signature: `${envelope.signature}x` })).toEqual({
      ok: false,
      reason: "signature-mismatch",
    });
  });

  it("makes nonce replay and saturation fail closed", () => {
    const ledger = new MemoryBrokerNonceLedger(2);
    expect(ledger.consume({ nonce: "nonce-a", nowMs: 1_000, expiresAtMs: 2_000 })).toBe(true);
    expect(ledger.consume({ nonce: "nonce-a", nowMs: 1_001, expiresAtMs: 2_000 })).toBe(false);
    expect(ledger.consume({ nonce: "nonce-b", nowMs: 1_001, expiresAtMs: 2_000 })).toBe(true);
    expect(ledger.consume({ nonce: "nonce-c", nowMs: 1_001, expiresAtMs: 2_000 })).toBe(false);
    expect(ledger.consume({ nonce: "nonce-c", nowMs: 2_000, expiresAtMs: 3_000 })).toBe(true);
  });
});
