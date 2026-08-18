import { randomBytes } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requestJsonlSocket } from "../infra/jsonl-socket.js";
import { createMemoryBrokerClient } from "./client.js";
import {
  createMemoryBrokerEnvelope,
  type MemoryBrokerAuthorizationBinding,
  type MemoryBrokerRequest,
} from "./protocol.js";
import { startMemoryBrokerServer, type MemoryBrokerServer } from "./server.js";

const secret = randomBytes(32);
const binding: MemoryBrokerAuthorizationBinding = {
  agentId: "agent-a",
  sessionId: "session-a",
  runId: "run-a",
  contextFingerprint: "context-a",
  subjectRevision: "subject-a",
  actorRevision: "actor-a",
  capabilitySnapshotId: "capability-a",
  policyRevision: "policy-a",
  deliveryRevision: "delivery-a",
};
const request: MemoryBrokerRequest = { method: "memory.search", payload: { query: "Alice" } };

let root: string | undefined;
let server: MemoryBrokerServer | undefined;

type StartOptions = Partial<
  Pick<
    Parameters<typeof startMemoryBrokerServer>[0],
    "handler" | "maximumPending" | "maximumRunning"
  >
>;

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (root) {
    await rm(root, { recursive: true, force: true });
  }
  root = undefined;
});

async function start(options: StartOptions = {}) {
  root = await mkdtemp(path.join(tmpdir(), "openclaw-memory-broker-"));
  const socketPath = path.join(root, "broker.sock");
  server = await startMemoryBrokerServer({
    socketPath,
    brokerId: "broker-a",
    brokerEpoch: "epoch-a",
    secret,
    handler: async ({ binding: received, request: receivedRequest }) => ({
      agentId: received.agentId,
      method: receivedRequest.method,
    }),
    ...options,
  });
  return socketPath;
}

function frame(overrides: Partial<{ envelope: unknown; request: unknown; nonce: string }> = {}) {
  const envelope = createMemoryBrokerEnvelope({
    secret,
    brokerId: "broker-a",
    brokerEpoch: "epoch-a",
    binding,
    nonce: overrides.nonce ?? "nonce-a",
    request,
    issuedAtMs: 1,
    expiresAtMs: Date.now() + 60_000,
  });
  expect(envelope).toBeDefined();
  return { envelope, request, ...overrides };
}

async function send(socketPath: string, value: unknown, options: { keepWriteOpen?: boolean } = {}) {
  return await requestJsonlSocket({
    socketPath,
    requestLine: JSON.stringify(value),
    timeoutMs: 5_000,
    ...options,
    accept: (response) => response as { ok: boolean; value?: unknown; error?: string },
  });
}

describe("memory broker server", () => {
  it("keeps the local socket private and admits one signed request", async () => {
    const socketPath = await start();
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    await expect(send(socketPath, frame())).resolves.toEqual({
      ok: true,
      value: { agentId: "agent-a", method: "memory.search" },
    });
  });

  it("rejects replay and a cross-context payload", async () => {
    const socketPath = await start();
    const first = frame();
    await expect(send(socketPath, first)).resolves.toMatchObject({ ok: true });
    await expect(send(socketPath, first)).resolves.toEqual({ ok: false, error: "replayed" });
    await expect(
      send(socketPath, {
        ...frame({
          envelope: createMemoryBrokerEnvelope({
            secret,
            brokerId: "broker-a",
            brokerEpoch: "epoch-a",
            binding,
            nonce: "nonce-b",
            request,
            issuedAtMs: 1,
            expiresAtMs: Date.now() + 60_000,
          }),
        }),
        request: { method: "memory.search", payload: { query: "Bob" } },
      }),
    ).resolves.toEqual({ ok: false, error: "unauthorized" });
  });

  it("accepts only Gateway-minted client requests and gives every call a new nonce", async () => {
    const socketPath = await start();
    let nonce = 0;
    const client = createMemoryBrokerClient({
      socketPath,
      brokerId: "broker-a",
      brokerEpoch: "epoch-a",
      secret,
      nonce: () => `nonce-${++nonce}`,
    });
    await expect(
      client.request({
        binding,
        method: "memory.search",
        payload: { query: "Alice" },
        expiresAtMs: Date.now() + 60_000,
      }),
    ).resolves.toEqual({ agentId: "agent-a", method: "memory.search" });
    await expect(
      client.request({
        binding,
        method: "memory.search",
        payload: { query: "Alice" },
        expiresAtMs: Date.now() + 60_000,
      }),
    ).resolves.toEqual({ agentId: "agent-a", method: "memory.search" });
    expect(nonce).toBe(2);
  });

  it("does not mint a broker envelope after a Gateway cancellation", async () => {
    const socketPath = await start();
    const controller = new AbortController();
    controller.abort();
    const client = createMemoryBrokerClient({
      socketPath,
      brokerId: "broker-a",
      brokerEpoch: "epoch-a",
      secret,
      nonce: () => {
        throw new Error("cancelled request must not mint a nonce");
      },
    });
    await expect(
      client.request({
        binding,
        method: "memory.search",
        payload: { query: "Alice" },
        expiresAtMs: Date.now() + 60_000,
        signal: controller.signal,
      }),
    ).resolves.toBeUndefined();
  });

  it("admits an immediately runnable request when no pending queue is allowed, then rejects saturation", async () => {
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const handlerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const handlerRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    const socketPath = await start({
      maximumPending: 0,
      maximumRunning: 1,
      handler: async () => {
        started?.();
        await handlerRelease;
        return { ok: true };
      },
    });
    const first = send(socketPath, frame({ nonce: "nonce-first" }), { keepWriteOpen: true });
    await handlerStarted;
    await expect(send(socketPath, frame({ nonce: "nonce-second" }))).resolves.toEqual({
      ok: false,
      error: "busy",
    });
    release?.();
    await expect(first).resolves.toEqual({ ok: true, value: { ok: true } });
  });

  it("quiesces new admission until accepted work drains, then resumes", async () => {
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const handlerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const handlerRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    const socketPath = await start({
      handler: async () => {
        started?.();
        await handlerRelease;
        return { ok: true };
      },
    });
    const first = send(socketPath, frame({ nonce: "nonce-first" }), { keepWriteOpen: true });
    await handlerStarted;
    const quiesced = server!.quiesce();
    await expect(send(socketPath, frame({ nonce: "nonce-second" }))).resolves.toEqual({
      ok: false,
      error: "busy",
    });
    release?.();
    await expect(first).resolves.toEqual({ ok: true, value: { ok: true } });
    await quiesced;
    server!.resume();
    await expect(send(socketPath, frame({ nonce: "nonce-third" }))).resolves.toEqual({
      ok: true,
      value: { ok: true },
    });
  });

  it("aborts an in-flight request when its Gateway client disconnects", async () => {
    let started: (() => void) | undefined;
    let aborted: (() => void) | undefined;
    const handlerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const handlerAborted = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    const socketPath = await start({
      handler: async ({ signal }) => {
        started?.();
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted?.();
              resolve();
            },
            { once: true },
          );
        });
        return { unreachable: true };
      },
    });
    const controller = new AbortController();
    const client = createMemoryBrokerClient({
      socketPath,
      brokerId: "broker-a",
      brokerEpoch: "epoch-a",
      secret,
    });
    const request = client.request({
      binding,
      method: "memory.search",
      payload: { query: "Alice" },
      expiresAtMs: Date.now() + 60_000,
      signal: controller.signal,
    });
    await handlerStarted;
    controller.abort();
    await expect(request).resolves.toBeUndefined();
    await expect(handlerAborted).resolves.toBeUndefined();
  });

  it("cancels an in-flight handler at the signed request deadline", async () => {
    let started: (() => void) | undefined;
    const handlerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const socketPath = await start({
      handler: async ({ signal }) => {
        started?.();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { unreachable: true };
      },
    });
    const deadline = Date.now() + 100;
    const pending = send(
      socketPath,
      frame({
        nonce: "nonce-deadline",
        envelope: createMemoryBrokerEnvelope({
          secret,
          brokerId: "broker-a",
          brokerEpoch: "epoch-a",
          binding,
          nonce: "nonce-deadline",
          request,
          issuedAtMs: Date.now(),
          expiresAtMs: deadline,
        }),
      }),
    );
    await handlerStarted;
    await expect(pending).resolves.toEqual({ ok: false, error: "cancelled" });
  });
});
