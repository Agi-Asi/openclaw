import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  nodeWorkerMemoryProjectionTransferPath,
  parseNodeWorkerMemoryProjectionRequestProof,
  NODE_WORKER_MEMORY_PROJECTION_PROOF_NODE_HEADER,
  NODE_WORKER_MEMORY_PROJECTION_PROOF_SIGNATURE_HEADER,
  NODE_WORKER_MEMORY_PROJECTION_PROOF_SIGNED_AT_HEADER,
  type NodeWorkerMemoryProjectionRequestProof,
} from "../../worker/node-memory-projection-protocol.js";
import { AUTH_RATE_LIMIT_SCOPE_WORKER_TRANSFER, type AuthRateLimiter } from "../auth-rate-limit.js";
import { classifyNodeWorkerProjectionTransferPath } from "../gateway-http-route-contracts.js";
import { sendJson, watchClientDisconnect } from "../http-common.js";
import { withSerializedRateLimitAttempt } from "../rate-limit-attempt-serialization.js";
import type { NodeWorkerProjectionTransferService } from "./node-worker-projection-transfer-service.js";

const OPAQUE_NOT_FOUND = { error: "not_found" } as const;

type NodeWorkerProjectionTransferHttpCallbackResult =
  | { kind: "unauthorized" }
  | { kind: "authorized"; handle: () => Promise<void> | void };

export type NodeWorkerProjectionTransferHttpCallback = (params: {
  req: IncomingMessage;
  res: ServerResponse;
  bearer: string;
  proof: NodeWorkerMemoryProjectionRequestProof;
}) => Promise<NodeWorkerProjectionTransferHttpCallbackResult>;

function bearerToken(req: IncomingMessage): string | undefined {
  const authorization = normalizeOptionalString(req.headers.authorization);
  if (!authorization?.toLowerCase().startsWith("bearer ")) {
    return undefined;
  }
  return normalizeOptionalString(authorization.slice(7));
}

function proofHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === "string" ? normalizeOptionalString(value) : undefined;
}

function requestProof(req: IncomingMessage): NodeWorkerMemoryProjectionRequestProof | undefined {
  const signedAt = proofHeader(req, NODE_WORKER_MEMORY_PROJECTION_PROOF_SIGNED_AT_HEADER);
  if (!signedAt || !/^(?:0|[1-9][0-9]{0,15})$/u.test(signedAt)) {
    return undefined;
  }
  return (
    parseNodeWorkerMemoryProjectionRequestProof({
      nodeId: proofHeader(req, NODE_WORKER_MEMORY_PROJECTION_PROOF_NODE_HEADER),
      signedAtMs: Number(signedAt),
      signature: proofHeader(req, NODE_WORKER_MEMORY_PROJECTION_PROOF_SIGNATURE_HEADER),
    }) ?? undefined
  );
}

function sendOpaqueNotFound(res: ServerResponse): void {
  sendJson(res, 404, OPAQUE_NOT_FOUND);
}

export async function handleNodeWorkerProjectionTransferHttpRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  clientIp: string | undefined;
  rateLimiter?: AuthRateLimiter;
  callback?: NodeWorkerProjectionTransferHttpCallback;
}): Promise<boolean> {
  const parsed = URL.parse(params.req.url ?? "/", "http://localhost");
  if (!parsed?.pathname || classifyNodeWorkerProjectionTransferPath(parsed.pathname) === "outside") {
    return false;
  }
  params.res.setHeader("Cache-Control", "no-store");
  if (parsed.pathname !== nodeWorkerMemoryProjectionTransferPath() || parsed.search || params.req.method !== "GET") {
    sendOpaqueNotFound(params.res);
    return true;
  }
  const bearer = bearerToken(params.req);
  const proof = requestProof(params.req);
  const admission = await withSerializedRateLimitAttempt<
    | { kind: "rate-limited"; retryAfterMs: number }
    | { kind: "unauthorized" }
    | Extract<NodeWorkerProjectionTransferHttpCallbackResult, { kind: "authorized" }>
  >({
    ip: params.clientIp,
    scope: AUTH_RATE_LIMIT_SCOPE_WORKER_TRANSFER,
    run: async () => {
      const rateCheck = params.rateLimiter?.check(
        params.clientIp,
        AUTH_RATE_LIMIT_SCOPE_WORKER_TRANSFER,
      );
      if (rateCheck && !rateCheck.allowed) {
        return { kind: "rate-limited", retryAfterMs: rateCheck.retryAfterMs };
      }
      const outcome =
        bearer && proof && params.callback
          ? await params.callback({ req: params.req, res: params.res, bearer, proof })
          : ({ kind: "unauthorized" } as const);
      if (outcome.kind === "unauthorized") {
        params.rateLimiter?.recordFailure(params.clientIp, AUTH_RATE_LIMIT_SCOPE_WORKER_TRANSFER);
      } else {
        params.rateLimiter?.reset(params.clientIp, AUTH_RATE_LIMIT_SCOPE_WORKER_TRANSFER);
      }
      return outcome;
    },
  });
  if (admission.kind === "rate-limited") {
    if (admission.retryAfterMs > 0) {
      params.res.setHeader("Retry-After", String(Math.ceil(admission.retryAfterMs / 1000)));
    }
    sendJson(params.res, 429, { error: "rate_limited" });
    return true;
  }
  if (admission.kind === "unauthorized") {
    sendOpaqueNotFound(params.res);
    return true;
  }
  await admission.handle();
  return true;
}

export function createNodeWorkerProjectionTransferHttpCallback(
  service: NodeWorkerProjectionTransferService,
): NodeWorkerProjectionTransferHttpCallback {
  return async ({ req, res, bearer, proof }) => {
    const authorization = await service.authorize(bearer, proof);
    if (!authorization) {
      return { kind: "unauthorized" };
    }
    return {
      kind: "authorized",
      handle: async () => {
        const clientAbort = new AbortController();
        const stopWatchingDisconnect = watchClientDisconnect(req, res, clientAbort);
        const timeoutMs = Math.max(1, authorization.expiresAtMs - Date.now());
        const signal = AbortSignal.any([
          service.authorizationSignal(authorization),
          clientAbort.signal,
          AbortSignal.timeout(timeoutMs),
        ]);
        try {
          const payload = service.payload(authorization);
          if (!payload || signal.aborted || !service.isAuthorizationCurrent(authorization)) {
            sendOpaqueNotFound(res);
            return;
          }
          sendJson(res, 200, payload);
        } finally {
          stopWatchingDisconnect();
          service.revoke(authorization);
        }
      },
    };
  };
}
