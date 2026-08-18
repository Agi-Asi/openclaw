import type { SessionRow } from "../../../packages/gateway-protocol/src/index.js";
import {
  isEmbeddedAgentRunHandleInProgress,
  isEmbeddedAgentRunInProgress,
} from "../../agents/embedded-agent-runner/runs.js";
import {
  hasProjectedAgentRunForSession,
  type ProjectedAgentRunIndex,
} from "../../infra/agent-run-registry.js";
import type { CommandQueueWorkProjection } from "../../process/command-queue.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveChatRunOwnerAgentId } from "../chat-run-owner.js";
import type { GatewayRequestContext } from "./types.js";

/** Active-run matcher including hidden remote lifecycle projections. */
type TrackedActiveSessionRun = {
  runId: string;
  workId: string;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
};

export function collectTrackedActiveSessionRuns(
  context: Partial<Pick<GatewayRequestContext, "chatAbortControllers">>,
): TrackedActiveSessionRun[] {
  const runs: TrackedActiveSessionRun[] = [];
  if (!(context.chatAbortControllers instanceof Map)) {
    return runs;
  }
  for (const [runId, active] of context.chatAbortControllers) {
    if (active.projectSessionActive !== false && active.controlUiVisible !== false) {
      const sessionKey = active.sessionKey?.trim();
      const sessionId = active.sessionId?.trim();
      if (!sessionKey && !sessionId) {
        continue;
      }
      runs.push({
        runId,
        workId: active.taskId?.trim() || runId,
        ...(sessionKey ? { sessionKey } : {}),
        ...(sessionId ? { sessionId } : {}),
        agentId: typeof active.agentId === "string" ? normalizeAgentId(active.agentId) : undefined,
      });
    }
  }
  return runs;
}

function isTrackedActiveSessionRunForKey(
  active: Pick<TrackedActiveSessionRun, "sessionKey" | "agentId">,
  key: string,
  agentId?: string,
  defaultAgentId?: string,
): boolean {
  if (!active.sessionKey || active.sessionKey !== key) {
    return false;
  }
  const requestedAgentId = resolveChatRunOwnerAgentId({
    agentId,
    sessionKey: key,
    defaultAgentId,
  });
  if (!requestedAgentId) {
    return false;
  }
  const activeAgentId = resolveChatRunOwnerAgentId({
    agentId: active.agentId,
    sessionKey: active.sessionKey,
    defaultAgentId,
  });
  return activeAgentId
    ? normalizeAgentId(activeAgentId) === normalizeAgentId(requestedAgentId)
    : false;
}

function isTrackedActiveSessionRunForSessionId(
  active: TrackedActiveSessionRun,
  sessionId: string,
  agentId?: string,
  defaultAgentId?: string,
): boolean {
  if (active.sessionId !== sessionId) {
    return false;
  }
  const requestedAgentId = agentId ?? defaultAgentId;
  if (!requestedAgentId) {
    return false;
  }
  return (
    resolveChatRunOwnerAgentId({
      agentId: active.agentId,
      sessionKey: active.sessionKey,
      defaultAgentId,
    }) === normalizeAgentId(requestedAgentId)
  );
}

export function hasRegisteredChatRunForSessionKey(params: {
  context: Partial<Pick<GatewayRequestContext, "chatAbortControllers">>;
  sessionKey: string;
  agentId: string | undefined;
  defaultAgentId?: string;
}): boolean {
  const controllers = params.context.chatAbortControllers;
  return (
    controllers instanceof Map &&
    [...controllers.values()].some((active) =>
      isTrackedActiveSessionRunForKey(
        active,
        params.sessionKey,
        params.agentId,
        params.defaultAgentId,
      ),
    )
  );
}

/** Returns true when either requested or canonical session key has a visible active run. */
export function hasTrackedActiveSessionRun(params: {
  context: Partial<Pick<GatewayRequestContext, "chatAbortControllers">>;
  requestedKey: string;
  canonicalKey: string;
  agentId?: string;
  defaultAgentId?: string;
  excludeRunIds?: ReadonlySet<string>;
}): boolean {
  const activeRuns = collectTrackedActiveSessionRuns(params.context);
  return activeRuns.some(
    (active) =>
      !params.excludeRunIds?.has(active.runId) &&
      (isTrackedActiveSessionRunForKey(
        active,
        params.canonicalKey,
        params.agentId,
        params.defaultAgentId,
      ) ||
        isTrackedActiveSessionRunForKey(
          active,
          params.requestedKey,
          params.agentId,
          params.defaultAgentId,
        )),
  );
}

export function resolveVisibleActiveSessionRunState(params: {
  context: Partial<Pick<GatewayRequestContext, "chatAbortControllers">>;
  requestedKey: string;
  canonicalKey: string;
  sessionId?: string;
  agentId?: string;
  defaultAgentId?: string;
  trackedActiveRuns?: readonly TrackedActiveSessionRun[];
  projectedAgentRunIndex?: ProjectedAgentRunIndex;
  queueProjection?: CommandQueueWorkProjection;
}): { active: boolean; runIds: string[]; runActivity?: SessionRow["runActivity"] } {
  const sessionId = params.sessionId?.trim();
  const resolvedAgentId =
    params.agentId ??
    parseAgentSessionKey(params.canonicalKey)?.agentId ??
    parseAgentSessionKey(params.requestedKey)?.agentId;
  const matchingTrackedRuns = (
    params.trackedActiveRuns ?? collectTrackedActiveSessionRuns(params.context)
  ).filter(
    (active) =>
      isTrackedActiveSessionRunForKey(
        active,
        params.canonicalKey,
        resolvedAgentId,
        params.defaultAgentId,
      ) ||
      isTrackedActiveSessionRunForKey(
        active,
        params.requestedKey,
        resolvedAgentId,
        params.defaultAgentId,
      ) ||
      (sessionId !== undefined &&
        isTrackedActiveSessionRunForSessionId(
          active,
          sessionId,
          resolvedAgentId,
          params.defaultAgentId,
        )),
  );
  const runIds = matchingTrackedRuns.map((active) => active.runId).toSorted();
  const hasProjectedRun = hasProjectedAgentRunForSession({
    sessionKeys: [params.requestedKey, params.canonicalKey],
    ...(sessionId ? { sessionId } : {}),
    ...(resolvedAgentId ? { agentId: resolvedAgentId } : {}),
    ...(params.defaultAgentId ? { defaultAgentId: params.defaultAgentId } : {}),
    ...(params.projectedAgentRunIndex ? { index: params.projectedAgentRunIndex } : {}),
  });
  const embeddedRunInProgress = sessionId !== undefined && isEmbeddedAgentRunInProgress(sessionId);
  const embeddedHandleInProgress =
    sessionId !== undefined && isEmbeddedAgentRunHandleInProgress(sessionId);
  // Connection, worker-lifecycle, and embedded registries are independent owners.
  // Settlement in one must not hide live work owned by another.
  const active = runIds.length > 0 || hasProjectedRun || embeddedRunInProgress;
  let runActivity: SessionRow["runActivity"] | undefined;
  if (params.queueProjection && matchingTrackedRuns.length > 0) {
    if (hasProjectedRun || embeddedHandleInProgress) {
      runActivity = { state: "working" };
    } else {
      const waits = matchingTrackedRuns.flatMap((run) => {
        const wait = params.queueProjection?.waits.get(run.workId);
        return wait ? [wait] : [];
      });
      if (waits.length === matchingTrackedRuns.length) {
        const wait = waits.reduce((earliest, candidate) =>
          candidate.since < earliest.since ? candidate : earliest,
        );
        runActivity = {
          state: "waiting",
          since: wait.since,
          queueWait: {
            queuedAhead: wait.queuedAhead,
            busySlots: wait.busySlots,
            capacity: wait.capacity,
            ...(wait.blockedBy ? { blockedBy: wait.blockedBy } : {}),
          },
        };
      } else {
        runActivity = { state: "working" };
      }
    }
  }
  return {
    active,
    runIds,
    ...(runActivity ? { runActivity } : {}),
  };
}
