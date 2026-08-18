import { chmod, unlink } from "node:fs/promises";
import net from "node:net";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  MemoryBrokerNonceLedger,
  verifyMemoryBrokerEnvelope,
  type MemoryBrokerAuthorizationBinding,
  type MemoryBrokerEnvelope,
  type MemoryBrokerRequest,
} from "./protocol.js";

export const MEMORY_BROKER_MAXIMUM_REQUEST_BYTES = 1_048_576;

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
}>;

/**
 * Admission is broker-owned rather than relying on socket backpressure. A noisy Gateway cannot
 * leave arbitrary requests retained in a local server's receive buffer while work is saturated.
 */
class MemoryBrokerAdmissionQueue {
  private readonly pending: PendingMemoryBrokerRequest[] = [];
  private readonly idleWaiters = new Set<() => void>();
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

  submit(request: PendingMemoryBrokerRequest): void {
    if (
      !this.accepting ||
      request.deadlineMs <= this.now() ||
      (this.running >= this.maximumRunning && this.pending.length >= this.maximumPending)
    ) {
      request.rejectBusy();
      return;
    }
    this.pending.push(request);
    this.drain();
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
        next.rejectBusy();
        continue;
      }
      this.running += 1;
      void next.execute().finally(() => {
        this.running -= 1;
        this.drain();
        this.notifyIdle();
      });
    }
    this.notifyIdle();
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

function asEnvelope(value: unknown): MemoryBrokerEnvelope | undefined {
  if (
    !isRecord(value) ||
    typeof value.nonce !== "string" ||
    typeof value.expiresAtMs !== "number"
  ) {
    return undefined;
  }
  return value as unknown as MemoryBrokerEnvelope;
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
  maximumRequestBytes?: number;
  now?: () => number;
}): Promise<MemoryBrokerServer> {
  const now = params.now ?? Date.now;
  const maximumRequestBytes = params.maximumRequestBytes ?? MEMORY_BROKER_MAXIMUM_REQUEST_BYTES;
  const nonceLedger = new MemoryBrokerNonceLedger(params.nonceCapacity ?? 1_024);
  const queue = new MemoryBrokerAdmissionQueue(
    params.maximumPending ?? 128,
    params.maximumRunning ?? 8,
    now,
  );
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    let buffer = Buffer.alloc(0);
    let consumed = false;
    const requestAbort = new AbortController();
    socket.on("end", () => requestAbort.abort());
    socket.on("close", () => requestAbort.abort());
    socket.on("error", () => requestAbort.abort());
    socket.on("data", (chunk: Buffer) => {
      if (consumed) {
        socket.destroy();
        return;
      }
      if (buffer.byteLength + chunk.byteLength > maximumRequestBytes) {
        consumed = true;
        writeResponse(socket, { ok: false, error: "invalid-request" });
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) {
        return;
      }
      consumed = true;
      if (buffer.subarray(newline + 1).some((byte) => byte !== 0x0a && byte !== 0x0d)) {
        writeResponse(socket, { ok: false, error: "invalid-request" });
        return;
      }
      let frame: MemoryBrokerWireRequest | undefined;
      try {
        frame = parseRequest(JSON.parse(buffer.subarray(0, newline).toString("utf8")));
      } catch {
        frame = undefined;
      }
      const request = frame ? parseMemoryBrokerRequest(frame.request) : undefined;
      const envelope = frame ? asEnvelope(frame.envelope) : undefined;
      if (!request || !envelope) {
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
      queue.submit({
        deadlineMs: envelope.expiresAtMs,
        rejectBusy: () => writeResponse(socket, { ok: false, error: "busy" }),
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
            if (requestAbort.signal.aborted || now() >= envelope.expiresAtMs) {
              writeResponse(socket, { ok: false, error: "cancelled" });
              return;
            }
            writeResponse(socket, { ok: true, value });
          } catch {
            writeResponse(socket, { ok: false, error: "failed" });
          } finally {
            clearTimeout(deadline);
          }
        },
      });
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
  return Object.freeze({
    socketPath: params.socketPath,
    brokerEpoch: params.brokerEpoch,
    quiesce: () => queue.quiesce(),
    resume: () => queue.resume(),
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await unlink(params.socketPath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      });
    },
  });
}
