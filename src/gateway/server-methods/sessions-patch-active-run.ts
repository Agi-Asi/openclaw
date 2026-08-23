import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionCreatedActor,
  type SessionsPatchActiveRunOutcome,
  type SessionsPatchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveEmbeddedSessionLane } from "../../agents/embedded-agent-runner/lanes.js";
import { isEmbeddedAgentRunInProgress } from "../../agents/embedded-agent-runner/runs.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import { hasPendingFollowupQueueWork } from "../../auto-reply/reply/queue/state.js";
import {
  isReplyRunActiveForSessionId,
  replyRunRegistry,
} from "../../auto-reply/reply/reply-run-registry.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { hasProjectedAgentRunForSession } from "../../infra/agent-run-registry.js";
import { getCommandLaneSnapshot } from "../../process/command-queue.js";
import { isCompetingSessionWorkAdmissionActive } from "../../sessions/session-lifecycle-admission.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "../session-request-agent.js";
import { isExecutionAuthorityPatch } from "../sessions-patch-authority.js";
import { projectSessionsPatchEntry } from "../sessions-patch.js";
import { asWorkerInferenceControl } from "../worker-environments/inference-control.js";
import { hasGatewaySessionAbortOwner } from "./chat-abort-runtime.js";
import {
  prepareSessionLifecycleDrain,
  type SessionLifecycleDrain,
} from "./sessions-archive-lifecycle.js";
import { resolveSessionWorkerPlacementPatchError } from "./sessions-shared.js";
import type { GatewayRequestContext } from "./types.js";

export type SessionPatchActiveRunPreparation = {
  drain: SessionLifecycleDrain;
  stopped: boolean;
};

function activeRunError(key: string): ErrorShape {
  return errorShape(
    ErrorCodes.INVALID_REQUEST,
    `Session ${key} has active work. Retry with activeRunPolicy "stop" or "stop-and-continue".`,
    { details: { reason: "session-active" } },
  );
}

function missingAuthorityIdentityError(key: string): ErrorShape {
  return errorShape(
    ErrorCodes.INVALID_REQUEST,
    `expectedSessionId and expectedLifecycleRevision are required for execution-authority patch: ${key}`,
  );
}

export async function validateSessionPatchAuthorityProjection(params: {
  archivedBy?: SessionCreatedActor;
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  currentEntry: SessionEntry;
  freshStore: Record<string, SessionEntry>;
  freshStoreKeys: string[];
  fullPatch: SessionsPatchParams;
  loadGatewayModelCatalog: () => Promise<ModelCatalogEntry[]>;
  primaryKey: string;
  requestedAgentId?: string;
  targetAgentId: string;
}): Promise<ErrorShape | undefined> {
  const candidateKeys = new Set(params.freshStoreKeys);
  const preview = await projectSessionsPatchEntry({
    cfg: params.cfg,
    existingEntry: params.currentEntry,
    isLabelInUse: (label) =>
      Object.entries(params.freshStore).some(
        ([sessionKey, entry]) => !candidateKeys.has(sessionKey) && entry.label === label,
      ),
    storeKey: params.primaryKey,
    agentId: params.requestedAgentId,
    patch: params.fullPatch,
    archivedBy: params.archivedBy,
    loadGatewayModelCatalog: params.loadGatewayModelCatalog,
  });
  if (!preview.ok) {
    return preview.error;
  }
  const placementError = resolveSessionWorkerPlacementPatchError({
    agentId: params.targetAgentId,
    cfg: params.cfg,
    context: params.context,
    entry: preview.entry,
    key: params.fullPatch.key,
    patch: params.fullPatch,
    sessionKey: params.primaryKey,
    validateModelRuntime: true,
  });
  return placementError ? errorShape(ErrorCodes.INVALID_REQUEST, placementError) : undefined;
}

function hasActiveSessionWork(params: {
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  entry: SessionEntry;
  lifecycleIdentities: string[];
  sessionKeys: string[];
  storePath: string;
  agentId: string;
}): boolean {
  const workIdentities = [...params.sessionKeys, params.entry.sessionId];
  return (
    isCompetingSessionWorkAdmissionActive(params.storePath, params.lifecycleIdentities) ||
    params.sessionKeys.some((key) => replyRunRegistry.isActive(key)) ||
    isReplyRunActiveForSessionId(params.entry.sessionId) ||
    isEmbeddedAgentRunInProgress(params.entry.sessionId) ||
    hasPendingFollowupQueueWork(workIdentities) ||
    workIdentities.some(
      (key) => getCommandLaneSnapshot(resolveEmbeddedSessionLane(key)).queuedCount > 0,
    ) ||
    hasGatewaySessionAbortOwner({
      context: params.context,
      sessionKeys: params.sessionKeys,
      sessionId: params.entry.sessionId,
      agentId: params.agentId,
      defaultAgentId: tryResolveSessionCompatibilityOwnerAgentId(
        params.cfg,
        params.sessionKeys[0]!,
      ),
    }) ||
    hasProjectedAgentRunForSession({
      sessionKeys: params.sessionKeys,
      sessionId: params.entry.sessionId,
      agentId: params.agentId,
      defaultAgentId: tryResolveSessionCompatibilityOwnerAgentId(
        params.cfg,
        params.sessionKeys[0]!,
      ),
    }) ||
    Boolean(
      params.context.workerSessionPlacementService
        ?.getMany([params.entry.sessionId])
        .get(params.entry.sessionId)?.turnClaim,
    ) ||
    (asWorkerInferenceControl(params.context.workerEnvironmentService)?.hasInferenceForSession(
      params.entry.sessionId,
    ) ??
      false) ||
    (params.context.terminalSessions?.hasAgentSessionWork({
      kind: "agent",
      agentSessionKey: params.sessionKeys[0]!,
      agentSessionId: params.entry.sessionId,
      agentId: params.agentId,
    }) ??
      false)
  );
}

export async function prepareSessionPatchActiveRun(params: {
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  entry: SessionEntry;
  fullPatch: SessionsPatchParams;
  lifecycleIdentities: string[];
  sessionKeys: string[];
  storePath: string;
  agentId: string;
}): Promise<
  { ok: true; value?: SessionPatchActiveRunPreparation } | { ok: false; error: ErrorShape }
> {
  if (!isExecutionAuthorityPatch(params.fullPatch)) {
    return { ok: true };
  }
  const policy = params.fullPatch.activeRunPolicy ?? "reject";
  if (
    policy === "stop-and-continue" &&
    (params.fullPatch.expectedSessionId === undefined ||
      params.fullPatch.expectedLifecycleRevision === undefined)
  ) {
    return { ok: false, error: missingAuthorityIdentityError(params.fullPatch.key) };
  }
  const active = hasActiveSessionWork(params);
  if (!active) {
    return { ok: true };
  }
  if (policy === "reject") {
    return { ok: false, error: activeRunError(params.fullPatch.key) };
  }
  if (
    params.fullPatch.expectedSessionId === undefined ||
    params.fullPatch.expectedLifecycleRevision === undefined
  ) {
    return { ok: false, error: missingAuthorityIdentityError(params.fullPatch.key) };
  }
  try {
    const drain = await prepareSessionLifecycleDrain({
      context: params.context,
      storePath: params.storePath,
      sessionKeys: params.sessionKeys,
      sessionId: params.entry.sessionId,
      sessionKey: params.sessionKeys[0]!,
      agentId: params.agentId,
      defaultAgentId: tryResolveSessionCompatibilityOwnerAgentId(
        params.cfg,
        params.sessionKeys[0]!,
      ),
      lifecycleIdentities: params.lifecycleIdentities,
      reclaimPlacement: false,
      stopReason: "session-policy-change",
    });
    return { ok: true, value: { drain, stopped: true } };
  } catch {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.UNAVAILABLE,
        `Session ${params.fullPatch.key} did not finish stopping. Retry the patch.`,
        { retryable: true },
      ),
    };
  }
}

export function activeRunPatchResult(params: {
  auditNote: "appended" | "failed";
  fullPatch: SessionsPatchParams;
  stopped: boolean;
  continuation?: SessionsPatchActiveRunOutcome["continuation"];
}): SessionsPatchActiveRunOutcome | undefined {
  if (!isExecutionAuthorityPatch(params.fullPatch)) {
    return undefined;
  }
  const requestedPolicy = params.fullPatch.activeRunPolicy ?? "reject";
  return {
    policy: requestedPolicy === "stop-and-continue" && !params.stopped ? "reject" : requestedPolicy,
    stopped: params.stopped,
    auditNote: params.auditNote,
    ...(params.continuation ? { continuation: params.continuation } : {}),
  };
}
