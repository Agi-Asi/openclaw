import { chmod, unlink } from "node:fs/promises";
import net from "node:net";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  MemoryBrokerNonceLedger,
  isMemoryBrokerEnvelope,
  verifyMemoryBrokerEnvelope,
  type MemoryBrokerAuthorizationBinding,
  type MemoryBrokerRequest,
} from "./protocol.js";

export const MEMORY_BROKER_MAXIMUM_REQUEST_BYTES = 1_048_576;
export const MEMORY_BROKER_MAXIMUM_CONNECTIONS = 32;
export const MEMORY_BROKER_PREAUTH_IDLE_TIMEOUT_MS = 5_000;

type MemoryBrokerWireRequest = Readonly<{
  envelope: unknown;
  request: unknown;
}>;

type MemoryBrokerWireResponse = Readonly<{
  ok: boolean;
  value?: unknown;
  error?: "invalid-request" | "unauthorized" | "replayed" | "busy" | "cancelled" | "failed";
}>;

export type MemoryBrokerHandler = (
  params: Readonly<{
    binding: MemoryBrokerAuthorizationBinding;
    request: MemoryBrokerRequest;
    signal: AbortSignal;
  }>,
) => Promise<unknown>;

type PendingMemoryBrokerRequest = Readonly<{
  deadlineMs: number;
  execute: () => Promise<void>;
  rejectBusy: () => void;
  rejectCancelled: () => void;
}>;

/**
 * Admission is broker-owned rather than relying on socket backpressure. A noisy Gateway cannot
 * leave arbitrary requests retained in a local server's receive buffer while work is saturated.
 */
class MemoryBrokerAdmissionQueue {
  private readonly pending: PendingMemoryBrokerRequest[] = [];
  private readonly idleWaiters = new Set<() => void>();
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  private running = 0;
  private accepting = true;

  constructor(
    private readonly maximumPending: number,
    private readonly maximumRunning: number,
    private readonly now: () => number,
  ) {
    if (
      !Number.isSafeInteger(maximumPending) ||
      maximumPending < 0 ||
      !Number.isSafeInteger(maximumRunning) ||
      maximumRunning < 1
    ) {
      throw new Error("memory broker admission limits are invalid");
    }
  }

  submit(request: PendingMemoryBrokerRequest): () => void {
    if (
      !this.accepting ||
      (this.running >= this.maximumRunning && this.pending.length >= this.maximumPending)
    ) {
      request.rejectBusy();
      return () => {};
    }
    if (request.deadlineMs <= this.now()) {
      request.rejectCancelled();
      return () => {};
    }
    this.pending.push(request);
    this.drain();
    return () => this.cancel(request);
  }

  async quiesce(): Promise<void> {
    this.accepting = false;
    if (this.running === 0 && this.pending.length === 0) {
      return;
    }
    await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }

  resume(): void {
    this.accepting = true;
    this.drain();
  }

  private notifyIdle(): void {
    if (this.running !== 0 || this.pending.length !== 0) {
      return;
    }
    for (const resolve of this.idleWaiters) {
      resolve();
    }
    this.idleWaiters.clear();
  }

  private drain(): void {
    while (this.running < this.maximumRunning && this.pending.length > 0) {
      const next = this.pending.shift()!;
      if (next.deadlineMs <= this.now()) {
        next.rejectCancelled();
        continue;
      }
      this.running += 1;
      void next.execute().finally(() => {
        this.running -= 1;
        this.drain();
        this.notifyIdle();
      });
    }
    this.schedulePendingDeadline();
    this.notifyIdle();
  }

  private cancel(request: PendingMemoryBrokerRequest): void {
    const index = this.pending.indexOf(request);
    if (index === -1) {
      return;
    }
    this.pending.splice(index, 1);
    this.schedulePendingDeadline();
    this.drain();
  }

  private schedulePendingDeadline(): void {
    if (this.deadlineTimer) {
      clearTimeout(this.deadlineTimer);
      this.deadlineTimer = undefined;
    }
    const nextDeadline = this.pending.reduce<number | undefined>(
      (earliest, request) =>
        earliest === undefined || request.deadlineMs < earliest ? request.deadlineMs : earliest,
      undefined,
    );
    if (nextDeadline === undefined) {
      return;
    }
    this.deadlineTimer = setTimeout(
      () => {
        this.deadlineTimer = undefined;
        const now = this.now();
        for (let index = this.pending.length - 1; index >= 0; index -= 1) {
          const request = this.pending[index];
          if (request.deadlineMs <= now) {
            this.pending.splice(index, 1);
            request.rejectCancelled();
          }
        }
        this.drain();
      },
      Math.max(1, nextDeadline - this.now()),
    );
    this.deadlineTimer.unref?.();
  }
}

function parseRequest(value: unknown): MemoryBrokerWireRequest | undefined {
  if (!isRecord(value) || !("envelope" in value) || !("request" in value)) {
    return undefined;
  }
  return { envelope: value.envelope, request: value.request };
}

function parseMemoryBrokerRequest(value: unknown): MemoryBrokerRequest | undefined {
  if (!isRecord(value) || typeof value.method !== "string" || !value.method) {
    return undefined;
  }
  return { method: value.method, payload: value.payload };
}

function writeResponse(socket: net.Socket, response: MemoryBrokerWireResponse): void {
  if (socket.destroyed) {
    return;
  }
  try {
    socket.end(`${JSON.stringify(response)}\n`);
  } catch {
    socket.destroy();
  }
}

/**
 * A successful mutation handler has crossed its durable activation boundary. Its response must
 * remain committed even if the caller disconnects while the broker is serializing the reply.
 */
function isDurableMemoryMutation(request: MemoryBrokerRequest): boolean {
  return request.method === "memory.write" || request.method === "memory.import";
}

export type MemoryBrokerServer = Readonly<{
  socketPath: string;
  brokerEpoch: string;
  /** Refuse newly admitted work and wait until pre-existing broker work has drained. */
  quiesce(): Promise<void>;
  /** Reopen admission after a Gateway-owned checkpoint, backup, repair, or replacement attempt. */
  resume(): void;
  close(): Promise<void>;
}>;

/**
 * Starts the authenticated local Unix-socket broker. This accepts exactly one framed request per
 * connection; the client cannot reuse a socket to smuggle a second request after a nonce is spent.
 */
export async function startMemoryBrokerServer(params: {
  socketPath: string;
  brokerId: string;
  brokerEpoch: string;
  secret: Uint8Array;
  handler: MemoryBrokerHandler;
  nonceCapacity?: number;
  maximumPending?: number;
  maximumRunning?: number;
  /** Bound unauthenticated sockets before they can consume a broker worker slot. */
  maximumConnections?: number;
  /** A partial frame is untrusted admission state, never an indefinitely retained request. */
  preauthIdleTimeoutMs?: number;
  maximumRequestBytes?: number;
  now?: () => number;
}): Promise<MemoryBrokerServer> {
  const now = params.now ?? Date.now;
  const maximumRequestBytes = params.maximumRequestBytes ?? MEMORY_BROKER_MAXIMUM_REQUEST_BYTES;
  const maximumConnections = params.maximumConnections ?? MEMORY_BROKER_MAXIMUM_CONNECTIONS;
  const preauthIdleTimeoutMs = params.preauthIdleTimeoutMs ?? MEMORY_BROKER_PREAUTH_IDLE_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(maximumConnections) ||
    maximumConnections < 1 ||
    !Number.isSafeInteger(preauthIdleTimeoutMs) ||
    preauthIdleTimeoutMs < 1
  ) {
    throw new Error("memory broker connection limits are invalid");
  }
  const nonceLedger = new MemoryBrokerNonceLedger(params.nonceCapacity ?? 1_024);
  const queue = new MemoryBrokerAdmissionQueue(
    params.maximumPending ?? 128,
    params.maximumRunning ?? 8,
    now,
  );
  const sockets = new Set<net.Socket>();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    // A client that has not completed one bounded signed frame has no broker authority. Keep its
    // footprint bounded before parsing so partial-frame clients cannot exhaust the broker.
    if (sockets.size >= maximumConnections) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    // Do not repeatedly concatenate an attacker-controlled partial frame: a byte-at-a-time
    // slowloris would turn that into quadratic copying before the absolute admission deadline.
    const frameChunks: Buffer[] = [];
    let frameByteLength = 0;
    let consumed = false;
    const requestAbort = new AbortController();
    const preauthIdleTimer = setTimeout(() => {
      if (!consumed) {
        consumed = true;
        requestAbort.abort();
        socket.destroy();
      }
    }, preauthIdleTimeoutMs);
    preauthIdleTimer.unref?.();
    socket.on("end", () => requestAbort.abort());
    socket.once("close", () => {
      clearTimeout(preauthIdleTimer);
      requestAbort.abort();
      sockets.delete(socket);
    });
    socket.on("error", () => requestAbort.abort());
    socket.on("data", (chunk: Buffer) => {
      if (consumed) {
        socket.destroy();
        return;
      }
      if (frameByteLength + chunk.byteLength > maximumRequestBytes) {
        consumed = true;
        writeResponse(socket, { ok: false, error: "invalid-request" });
        return;
      }
      frameChunks.push(chunk);
      frameByteLength += chunk.byteLength;
      // Every prior chunk has been checked and contains no newline, so only the latest chunk
      // needs scanning until there is one complete frame to concatenate exactly once.
      const newline = chunk.indexOf(0x0a);
      if (newline === -1) {
        return;
      }
      consumed = true;
      clearTimeout(preauthIdleTimer);
      const buffer = Buffer.concat(frameChunks, frameByteLength);
      const frameNewline = buffer.indexOf(0x0a);
      if (buffer.subarray(frameNewline + 1).some((byte) => byte !== 0x0a && byte !== 0x0d)) {
        writeResponse(socket, { ok: false, error: "invalid-request" });
        return;
      }
      let frame: MemoryBrokerWireRequest | undefined;
      try {
        frame = parseRequest(JSON.parse(buffer.subarray(0, frameNewline).toString("utf8")));
      } catch {
        frame = undefined;
      }
      const request = frame ? parseMemoryBrokerRequest(frame.request) : undefined;
      const envelope = frame?.envelope;
      if (!request || !isMemoryBrokerEnvelope(envelope)) {
        writeResponse(socket, { ok: false, error: "invalid-request" });
        return;
      }
      const verification = verifyMemoryBrokerEnvelope({
        secret: params.secret,
        brokerId: params.brokerId,
        brokerEpoch: params.brokerEpoch,
        envelope,
        request,
        nowMs: now(),
      });
      if (!verification.ok) {
        writeResponse(socket, { ok: false, error: "unauthorized" });
        return;
      }
      if (
        !nonceLedger.consume({
          nonce: envelope.nonce,
          expiresAtMs: envelope.expiresAtMs,
          nowMs: now(),
        })
      ) {
        writeResponse(socket, { ok: false, error: "replayed" });
        return;
      }
      const cancelPending = queue.submit({
        deadlineMs: envelope.expiresAtMs,
        rejectBusy: () => writeResponse(socket, { ok: false, error: "busy" }),
        rejectCancelled: () => writeResponse(socket, { ok: false, error: "cancelled" }),
        execute: async () => {
          if (requestAbort.signal.aborted || now() >= envelope.expiresAtMs) {
            writeResponse(socket, { ok: false, error: "cancelled" });
            return;
          }
          const deadline = setTimeout(
            () => requestAbort.abort(),
            Math.max(1, envelope.expiresAtMs - now()),
          );
          try {
            const value = await params.handler({
              binding: envelope.binding,
              request,
              signal: requestAbort.signal,
            });
            if (
              !isDurableMemoryMutation(request) &&
              (requestAbort.signal.aborted || now() >= envelope.expiresAtMs)
            ) {
              writeResponse(socket, { ok: false, error: "cancelled" });
              return;
            }
            writeResponse(socket, { ok: true, value });
          } catch {
            writeResponse(socket, {
              ok: false,
              error:
                requestAbort.signal.aborted || now() >= envelope.expiresAtMs
                  ? "cancelled"
                  : "failed",
            });
          } finally {
            clearTimeout(deadline);
          }
        },
      });
      requestAbort.signal.addEventListener("abort", cancelPending, { once: true });
      if (requestAbort.signal.aborted) {
        cancelPending();
      }
    });
  });
  await unlink(params.socketPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(params.socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(params.socketPath, 0o600);
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    socketPath: params.socketPath,
    brokerEpoch: params.brokerEpoch,
    quiesce: () => queue.quiesce(),
    resume: () => queue.resume(),
    close: () => {
      closePromise ??= (async () => {
        // net.Server.close waits for every accepted socket. Destroy incomplete and in-flight
        // connections first so shutdown cannot be held hostage by a slowloris or stalled client.
        for (const socket of sockets) {
          socket.destroy();
        }
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
        await unlink(params.socketPath).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        });
      })();
      return closePromise;
    },
  });
}
