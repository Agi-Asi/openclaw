import { randomUUID } from "node:crypto";
import { requestJsonlSocket } from "../infra/jsonl-socket.js";
import {
  createMemoryBrokerEnvelope,
  type MemoryBrokerAuthorizationBinding,
  type MemoryBrokerRequest,
} from "./protocol.js";

type MemoryBrokerResponse = Readonly<{
  ok: boolean;
  value?: unknown;
  error?: string;
}>;

type MemoryBrokerClientRequest = Readonly<{
  binding: MemoryBrokerAuthorizationBinding;
  method: string;
  payload: unknown;
  expiresAtMs: number;
  signal?: AbortSignal;
}>;

export type MemoryBrokerClient = Readonly<{
  request<T>(params: MemoryBrokerClientRequest): Promise<T | undefined>;
}>;

/**
 * Gateway-only client. Callers must pass an already materialized host binding; this surface never
 * accepts a worker principal, session, policy revision, or reusable capability as tool input.
 */
export function createMemoryBrokerClient(params: {
  socketPath: string;
  brokerId: string;
  brokerEpoch: string;
  secret: Uint8Array;
  now?: () => number;
  nonce?: () => string;
}): MemoryBrokerClient {
  const now = params.now ?? Date.now;
  const nonce = params.nonce ?? randomUUID;
  return Object.freeze({
    async request<T>(requestParams: MemoryBrokerClientRequest) {
      if (
        !Number.isSafeInteger(requestParams.expiresAtMs) ||
        requestParams.expiresAtMs <= now() ||
        requestParams.signal?.aborted
      ) {
        return undefined;
      }
      const request: MemoryBrokerRequest = {
        method: requestParams.method,
        payload: requestParams.payload,
      };
      const envelope = createMemoryBrokerEnvelope({
        secret: params.secret,
        brokerId: params.brokerId,
        brokerEpoch: params.brokerEpoch,
        binding: requestParams.binding,
        nonce: nonce(),
        request,
        issuedAtMs: now(),
        expiresAtMs: requestParams.expiresAtMs,
      });
      if (!envelope) {
        return undefined;
      }
      const timeoutMs = Math.max(1, requestParams.expiresAtMs - now());
      const response = await requestJsonlSocket({
        socketPath: params.socketPath,
        requestLine: JSON.stringify({ envelope, request }),
        timeoutMs,
        keepWriteOpen: true,
        ...(requestParams.signal ? { signal: requestParams.signal } : {}),
        accept: (value) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            return undefined;
          }
          const response = value as MemoryBrokerResponse;
          return typeof response.ok === "boolean" ? response : undefined;
        },
      });
      return response?.ok === true ? (response.value as T) : undefined;
    },
  });
}
