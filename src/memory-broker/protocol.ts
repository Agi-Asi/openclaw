import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** The local memory-broker wire contract. Additive methods are feature-gated by the Gateway. */
export const MEMORY_BROKER_PROTOCOL_VERSION = 1 as const;

export const MEMORY_BROKER_MAXIMUM_NONCE_LENGTH = 256;

export type MemoryBrokerAuthorizationBinding = Readonly<{
  agentId: string;
  sessionId: string;
  runId: string;
  contextFingerprint: string;
  subjectRevision: string;
  actorRevision: string;
  capabilitySnapshotId: string;
  policyRevision: string;
  deliveryRevision: string;
}>;

export type MemoryBrokerRequest = Readonly<{
  method: string;
  payload: unknown;
}>;

export type MemoryBrokerEnvelope = Readonly<{
  version: typeof MEMORY_BROKER_PROTOCOL_VERSION;
  brokerId: string;
  brokerEpoch: string;
  binding: MemoryBrokerAuthorizationBinding;
  nonce: string;
  issuedAtMs: number;
  expiresAtMs: number;
  requestDigest: string;
  signature: string;
}>;

export type MemoryBrokerEnvelopeVerification =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      reason:
        | "invalid-envelope"
        | "broker-mismatch"
        | "epoch-mismatch"
        | "expired"
        | "request-mismatch"
        | "signature-mismatch"
        | "binding-mismatch";
    }>;

type UnsignedMemoryBrokerEnvelope = Omit<MemoryBrokerEnvelope, "signature">;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * The MAC covers a deterministic JSON representation. Rejecting non-JSON values is deliberate:
 * a request that cannot be reproduced byte-for-byte cannot be safely bound to a single-use grant.
 */
function canonicalize(value: unknown): string | undefined {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : undefined;
    case "object": {
      if (Array.isArray(value)) {
        const items: string[] = [];
        for (const item of value) {
          const serialized = canonicalize(item);
          if (serialized === undefined) {
            return undefined;
          }
          items.push(serialized);
        }
        return `[${items.join(",")}]`;
      }
      if (!isPlainRecord(value)) {
        return undefined;
      }
      const entries: string[] = [];
      for (const key of Object.keys(value).toSorted()) {
        const serialized = canonicalize(value[key]);
        if (serialized === undefined) {
          return undefined;
        }
        entries.push(`${JSON.stringify(key)}:${serialized}`);
      }
      return `{${entries.join(",")}}`;
    }
    default:
      return undefined;
  }
}

function digest(value: unknown): string | undefined {
  const serialized = canonicalize(value);
  return serialized === undefined
    ? undefined
    : createHash("sha256").update(serialized).digest("base64url");
}

function sign(secret: Uint8Array, envelope: UnsignedMemoryBrokerEnvelope): string | undefined {
  const serialized = canonicalize(envelope);
  return serialized === undefined
    ? undefined
    : createHmac("sha256", secret).update(serialized).digest("base64url");
}

function hasSafeIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MEMORY_BROKER_MAXIMUM_NONCE_LENGTH
  );
}

function isBinding(value: unknown): value is MemoryBrokerAuthorizationBinding {
  if (!isPlainRecord(value)) {
    return false;
  }
  return [
    value.agentId,
    value.sessionId,
    value.runId,
    value.contextFingerprint,
    value.subjectRevision,
    value.actorRevision,
    value.capabilitySnapshotId,
    value.policyRevision,
    value.deliveryRevision,
  ].every(hasSafeIdentifier);
}

function isEnvelope(value: unknown): value is MemoryBrokerEnvelope {
  if (
    !isPlainRecord(value) ||
    value.version !== MEMORY_BROKER_PROTOCOL_VERSION ||
    !isBinding(value.binding)
  ) {
    return false;
  }
  return (
    hasSafeIdentifier(value.brokerId) &&
    hasSafeIdentifier(value.brokerEpoch) &&
    hasSafeIdentifier(value.nonce) &&
    hasSafeIdentifier(value.requestDigest) &&
    hasSafeIdentifier(value.signature) &&
    typeof value.issuedAtMs === "number" &&
    Number.isSafeInteger(value.issuedAtMs) &&
    typeof value.expiresAtMs === "number" &&
    Number.isSafeInteger(value.expiresAtMs) &&
    value.expiresAtMs > value.issuedAtMs
  );
}

export function createMemoryBrokerEnvelope(params: {
  secret: Uint8Array;
  brokerId: string;
  brokerEpoch: string;
  binding: MemoryBrokerAuthorizationBinding;
  nonce: string;
  request: MemoryBrokerRequest;
  issuedAtMs: number;
  expiresAtMs: number;
}): MemoryBrokerEnvelope | undefined {
  const requestDigest = digest(params.request);
  const unsigned: UnsignedMemoryBrokerEnvelope = {
    version: MEMORY_BROKER_PROTOCOL_VERSION,
    brokerId: params.brokerId,
    brokerEpoch: params.brokerEpoch,
    binding: params.binding,
    nonce: params.nonce,
    issuedAtMs: params.issuedAtMs,
    expiresAtMs: params.expiresAtMs,
    requestDigest: requestDigest ?? "",
  };
  if (!requestDigest || !isEnvelope({ ...unsigned, signature: "pending" })) {
    return undefined;
  }
  const signature = sign(params.secret, unsigned);
  return signature ? Object.freeze({ ...unsigned, signature }) : undefined;
}

export function verifyMemoryBrokerEnvelope(params: {
  secret: Uint8Array;
  brokerId: string;
  brokerEpoch: string;
  /** A Gateway-side caller may recheck a freshly derived live binding before sending. */
  expectedBinding?: MemoryBrokerAuthorizationBinding;
  envelope: unknown;
  request: MemoryBrokerRequest;
  nowMs: number;
}): MemoryBrokerEnvelopeVerification {
  const { envelope } = params;
  if (!isEnvelope(envelope)) {
    return { ok: false, reason: "invalid-envelope" };
  }
  if (envelope.brokerId !== params.brokerId) {
    return { ok: false, reason: "broker-mismatch" };
  }
  if (envelope.brokerEpoch !== params.brokerEpoch) {
    return { ok: false, reason: "epoch-mismatch" };
  }
  if (params.nowMs < envelope.issuedAtMs || params.nowMs >= envelope.expiresAtMs) {
    return { ok: false, reason: "expired" };
  }
  const requestDigest = digest(params.request);
  if (!requestDigest || requestDigest !== envelope.requestDigest) {
    return { ok: false, reason: "request-mismatch" };
  }
  if (
    params.expectedBinding !== undefined &&
    canonicalize(envelope.binding) !== canonicalize(params.expectedBinding)
  ) {
    return { ok: false, reason: "binding-mismatch" };
  }
  const expectedSignature = sign(params.secret, {
    version: envelope.version,
    brokerId: envelope.brokerId,
    brokerEpoch: envelope.brokerEpoch,
    binding: envelope.binding,
    nonce: envelope.nonce,
    issuedAtMs: envelope.issuedAtMs,
    expiresAtMs: envelope.expiresAtMs,
    requestDigest: envelope.requestDigest,
  });
  if (!expectedSignature) {
    return { ok: false, reason: "invalid-envelope" };
  }
  const supplied = Buffer.from(envelope.signature);
  const expected = Buffer.from(expectedSignature);
  if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
    return { ok: false, reason: "signature-mismatch" };
  }
  return { ok: true };
}

/**
 * A broker epoch is rotated on each start, so this bounded ledger only has to remember requests
 * for the current process lifetime. Pre-restart envelopes fail against the new epoch before replay
 * lookup; the old process never accepts a request after it begins draining.
 */
export class MemoryBrokerNonceLedger {
  private readonly consumed = new Map<string, number>();

  constructor(private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error("memory broker nonce capacity must be a positive integer");
    }
  }

  consume(params: { nonce: string; expiresAtMs: number; nowMs: number }): boolean {
    for (const [nonce, expiresAtMs] of this.consumed) {
      if (expiresAtMs <= params.nowMs) {
        this.consumed.delete(nonce);
      }
    }
    if (
      !hasSafeIdentifier(params.nonce) ||
      !Number.isSafeInteger(params.expiresAtMs) ||
      params.expiresAtMs <= params.nowMs ||
      this.consumed.has(params.nonce) ||
      this.consumed.size >= this.capacity
    ) {
      return false;
    }
    this.consumed.set(params.nonce, params.expiresAtMs);
    return true;
  }

  get size(): number {
    return this.consumed.size;
  }
}
