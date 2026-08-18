import type { SessionObserverDigest } from "../../../packages/gateway-protocol/src/schema/sessions.js";

// Freshest-wins reconciliation for observer digest copies (live event map vs
// projected session row). Revisions are session-monotonic by server contract
// (revision floors preserve continuity across runs), so cross-copy comparison
// by revision, then updatedAt, is safe.
type ComparableObserverDigest = { revision: number; updatedAt: number };

type ProjectedObserverDigest = Pick<
  SessionObserverDigest,
  "agentId" | "runId" | "headline" | "health" | "updatedAt" | "revision"
>;

export function projectSessionObserverDigest(
  sessionKey: string,
  digest: ProjectedObserverDigest | null | undefined,
): SessionObserverDigest | null {
  if (!digest) {
    return null;
  }
  return {
    sessionKey,
    ...(digest.agentId ? { agentId: digest.agentId } : {}),
    runId: digest.runId,
    revision: digest.revision,
    updatedAt: digest.updatedAt,
    headline: digest.headline,
    health: digest.health,
  };
}

export function isCriticalObserverHealth(health: unknown): health is "stuck" | "waiting-on-user" {
  return health === "stuck" || health === "waiting-on-user";
}

export function isObserverDigestRunAuthoritative(params: {
  digestRunId: string | null | undefined;
  localRunId: string | null | undefined;
  trackedRunIds?: ReadonlySet<string>;
}): boolean {
  const digestRunId = params.digestRunId?.trim();
  if (!digestRunId) {
    return false;
  }
  return (
    digestRunId === params.localRunId?.trim() || params.trackedRunIds?.has(digestRunId) === true
  );
}

/** Local live run id wins; otherwise only locally owned digest identities render. */
export function resolveChatPaneObserverRunId(params: {
  localRunId: string | null;
  session: { hasActiveRun?: boolean } | undefined;
  digest: { runId?: string } | null;
  trackedRunIds?: ReadonlySet<string>;
}): string | null {
  if (params.localRunId) {
    return params.localRunId;
  }
  if (!params.session?.hasActiveRun) {
    return null;
  }
  return isObserverDigestRunAuthoritative({
    digestRunId: params.digest?.runId,
    localRunId: null,
    trackedRunIds: params.trackedRunIds,
  })
    ? (params.digest?.runId ?? null)
    : null;
}

export function pickFreshestObserverDigest<T extends ComparableObserverDigest>(
  first: T,
  second: T,
): T;
export function pickFreshestObserverDigest<T extends ComparableObserverDigest>(
  first: T | null | undefined,
  second: T | null | undefined,
): T | null;
export function pickFreshestObserverDigest<T extends ComparableObserverDigest>(
  first: T | null | undefined,
  second: T | null | undefined,
): T | null {
  if (!first) {
    return second ?? null;
  }
  if (!second) {
    return first;
  }
  if (first.revision !== second.revision) {
    return first.revision > second.revision ? first : second;
  }
  return first.updatedAt >= second.updatedAt ? first : second;
}
