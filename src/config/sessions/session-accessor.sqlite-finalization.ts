import { AsyncLocalStorage } from "node:async_hooks";
import type { PluginSessionDeletionEvent } from "../../plugins/plugin-api.types.js";
import { capturePluginSessionDeletionFinalizers } from "../../plugins/session-deletion-finalizers.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { isCompetingSessionWorkAdmissionActive } from "../../sessions/session-lifecycle-admission.js";

type SessionDeletionFinalization = {
  agentId: string;
  finalizers: ReturnType<typeof capturePluginSessionDeletionFinalizers>;
  ownerStorePath: string;
  pending: Map<string, { event: PluginSessionDeletionEvent; isRetained: () => boolean }>;
  physicalStorePath: string;
};
type SessionGeneration = { lifecycleRevision?: string; sessionId?: string };

const sessionDeletionFinalizations = new AsyncLocalStorage<SessionDeletionFinalization>();
const finalizingSessionGenerations = new Map<string, Map<string, PluginSessionDeletionEvent>>();

/** Deletion committed, so callers must surface the recovery action instead of retrying the row. */
export class SessionDeletionFinalizationError extends Error {
  constructor(cause: unknown) {
    super("session row committed; plugin cleanup incomplete; run openclaw doctor --fix", { cause });
    this.name = "SessionDeletionFinalizationError";
  }
}

/** Keep post-commit cleanup inside the one physical SQLite writer operation. */
export async function runWithSessionDeletionFinalization<T>(
  scope: Pick<SessionDeletionFinalization, "agentId" | "ownerStorePath" | "physicalStorePath">,
  run: () => Promise<T>,
): Promise<T> {
  const finalization: SessionDeletionFinalization = {
    ...scope,
    finalizers: capturePluginSessionDeletionFinalizers(),
    pending: new Map(),
  };
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = {
      ok: true,
      value: await sessionDeletionFinalizations.run(finalization, run),
    };
  } catch (error) {
    outcome = { ok: false, error };
  }

  const finalizerFailures: unknown[] = [];
  const pending = [...finalization.pending.values()].filter(({ isRetained }) => !isRetained());
  if (pending.length > 0) {
    finalizingSessionGenerations.set(
      scope.physicalStorePath,
      new Map(pending.map(({ event }) => [JSON.stringify(event), event])),
    );
  }
  try {
    for (const { event } of pending) {
      try {
        await finalization.finalizers?.finalize(event);
      } catch (error) {
        finalizerFailures.push(error);
      }
    }
  } finally {
    finalizingSessionGenerations.delete(scope.physicalStorePath);
  }
  if (finalizerFailures.length > 0) {
    const failures = outcome.ok ? finalizerFailures : [outcome.error, ...finalizerFailures];
    throw new SessionDeletionFinalizationError(
      failures.length === 1 ? failures[0] : new AggregateError(failures, "session deletion failed"),
    );
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}

/** Sync runtimes may update their current generation, never resurrect one being finalized. */
export function assertSessionDeletionWriteAllowed(
  physicalStorePath: string,
  sessionKey: string,
  entry: SessionGeneration,
  current?: SessionGeneration,
): void {
  if (
    current &&
    current.sessionId === entry.sessionId &&
    current.lifecycleRevision === entry.lifecycleRevision
  ) {
    return;
  }
  const active = finalizingSessionGenerations.get(physicalStorePath);
  if (
    active &&
    [...active.values()].some(
      (event) => event.sessionKey === sessionKey || event.sessionId === entry.sessionId,
    )
  ) {
    throw new Error(
      `session deletion finalization is still in progress for ${sessionKey}; retry after plugin cleanup completes`,
    );
  }
}

/** Validate competing admission at the SQL edge; publish only from a successful COMMIT. */
export function prepareSessionDeletionFinalization(
  params: Omit<PluginSessionDeletionEvent, "agentId" | "agentHarnessId"> & {
    agentHarnessId?: string;
    kind: "delete" | "replace";
    isRetained: () => boolean;
  },
): (() => void) | undefined {
  const finalization = sessionDeletionFinalizations.getStore();
  if (!finalization) {
    throw new Error(
      `session deletion requires its physical SQLite writer owner: ${params.sessionKey}`,
    );
  }
  const { agentHarnessId, isRetained, kind, sessionId, sessionKey } = params;
  if (
    kind === "delete" &&
    isCompetingSessionWorkAdmissionActive(finalization.ownerStorePath, [sessionKey, sessionId])
  ) {
    throw new Error(
      `cannot delete session while competing work is in flight for ${sessionKey}; retry after the run completes`,
    );
  }
  if (!agentHarnessId || !finalization.finalizers) {
    return undefined;
  }
  const event: PluginSessionDeletionEvent = Object.freeze({
    agentId: parseAgentSessionKey(sessionKey)?.agentId ?? finalization.agentId,
    agentHarnessId,
    sessionId,
    sessionKey,
    ...(params.lifecycleRevision ? { lifecycleRevision: params.lifecycleRevision } : {}),
  });
  if (!finalization.finalizers.assertCurrent(agentHarnessId)) {
    return undefined;
  }
  return () => finalization.pending.set(JSON.stringify(event), { event, isRetained });
}
