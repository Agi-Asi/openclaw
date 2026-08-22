import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export type SessionStartupResolution = "cancel" | "work-local";
export type SessionStartupResolveResult = "resolved" | "missing" | "mismatch" | "settling";

type SessionStartupOperation = {
  abort: AbortController;
  key: string;
  lifecycleRevision?: string;
  resolution?: SessionStartupResolution;
  sessionId: string;
};

const operations = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionStartupOperations"),
  () => new Map<string, SessionStartupOperation>(),
);

export function registerSessionStartupOperation(params: {
  key: string;
  lifecycleRevision?: string;
  operationId: string;
  sessionId: string;
}) {
  const operation: SessionStartupOperation = {
    abort: new AbortController(),
    key: params.key,
    lifecycleRevision: params.lifecycleRevision,
    sessionId: params.sessionId,
  };
  operations.set(params.operationId, operation);
  return {
    signal: operation.abort.signal,
    resolution: () => operation.resolution,
    release: () => {
      if (operations.get(params.operationId) === operation) {
        operations.delete(params.operationId);
      }
    },
  };
}

export function resolveSessionStartupOperation(params: {
  action: SessionStartupResolution;
  key: string;
  lifecycleRevision?: string;
  operationId: string;
  sessionId: string;
}): SessionStartupResolveResult {
  const operation = operations.get(params.operationId);
  if (!operation) {
    return "missing";
  }
  if (
    operation.key !== params.key ||
    operation.lifecycleRevision !== params.lifecycleRevision ||
    operation.sessionId !== params.sessionId
  ) {
    return "mismatch";
  }
  if (operation.abort.signal.aborted) {
    return "settling";
  }
  operation.resolution = params.action;
  operation.abort.abort(
    new Error(
      params.action === "cancel" ? "worktree setup cancelled" : "worktree setup moved local",
    ),
  );
  return "resolved";
}
