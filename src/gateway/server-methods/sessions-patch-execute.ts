import type {
  ErrorShape,
  RequestFrame,
  SessionsPatchActiveRunOutcome,
  SessionsPatchManyResult,
  SessionsPatchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import { projectSessionPatchResult } from "../session-utils-model.js";
import {
  resolveGatewaySessionStoreTargetWithStore,
  type SessionsPatchResult,
} from "../session-utils.js";
import { isExecutionAuthorityPatch } from "../sessions-patch-authority.js";
import { launchSessionPatchContinuation } from "./session-patch-continuation.js";
import { activeRunPatchResult } from "./sessions-patch-active-run.js";
import { executeSessionPatchMutations, type PatchTargetIdentity } from "./sessions-patch-engine.js";
import { sessionLog } from "./sessions-shared.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  SessionMutationAuthorization,
} from "./types.js";

function unexpectedPatchError(key: string, error: unknown): ErrorShape {
  sessionLog.warn(`sessions.patch: target failed for ${key}: ${formatErrorMessage(error)}`);
  return errorShape(
    ErrorCodes.UNAVAILABLE,
    "Session patch failed unexpectedly. Retry the request.",
    {
      retryable: true,
    },
  );
}

function createCommitGuard(key: string, assertCurrent: (() => void) | undefined) {
  return (): ErrorShape | undefined => {
    try {
      assertCurrent?.();
      return undefined;
    } catch (error) {
      return error instanceof SessionMutationAuthorizationChangedError
        ? error.error
        : unexpectedPatchError(key, error);
    }
  };
}

export async function executeSessionPatchMany(params: {
  client: GatewayClient | null;
  context: GatewayRequestContext;
  patch: Omit<SessionsPatchParams, keyof PatchTargetIdentity>;
  sessionMutationAuthorization?: SessionMutationAuthorization;
  targets: readonly PatchTargetIdentity[];
}): Promise<
  { ok: false; error: ErrorShape } | { ok: true; outcomes: SessionsPatchManyResult["outcomes"] }
> {
  const executed = await executeSessionPatchMutations({
    client: params.client,
    context: params.context,
    patch: params.patch,
    // Batch has no stop policy surface: execution-authority changes still use
    // exact CAS, reject active work, and rotate the lifecycle when idle.
    manageActiveRunPolicy: true,
    targets: params.targets.map((target) => ({
      ...target,
      commitGuard: createCommitGuard(target.key.trim(), () =>
        params.sessionMutationAuthorization?.assertTargetCurrent({
          sessionKey: target.key.trim(),
          ...(target.agentId ? { agentId: target.agentId } : {}),
        }),
      ),
    })),
  });
  if (!executed.ok) {
    return executed;
  }
  return {
    ok: true,
    outcomes: executed.outcomes.map((outcome, index) => {
      const target = params.targets[index]!;
      return outcome.ok
        ? target.agentId
          ? { ok: true, key: target.key, agentId: target.agentId }
          : { ok: true, key: target.key }
        : target.agentId
          ? { ok: false, key: target.key, agentId: target.agentId, error: outcome.error }
          : { ok: false, key: target.key, error: outcome.error };
    }),
  };
}

export async function executeSessionPatch(params: {
  client: GatewayClient | null;
  context: GatewayRequestContext;
  patch: SessionsPatchParams;
  req: RequestFrame;
  sessionMutationAuthorization?: SessionMutationAuthorization;
}): Promise<{ ok: false; error: ErrorShape } | { ok: true; result: SessionsPatchResult }> {
  const target = {
    key: params.patch.key,
    ...(params.patch.agentId ? { agentId: params.patch.agentId } : {}),
    ...(params.patch.expectedSessionId !== undefined
      ? { expectedSessionId: params.patch.expectedSessionId }
      : {}),
    ...(params.patch.expectedLifecycleRevision !== undefined
      ? { expectedLifecycleRevision: params.patch.expectedLifecycleRevision }
      : {}),
  };
  const executed = await executeSessionPatchMutations({
    client: params.client,
    context: params.context,
    patch: params.patch,
    manageActiveRunPolicy: true,
    targets: [
      {
        ...target,
        commitGuard: createCommitGuard(
          target.key,
          params.sessionMutationAuthorization?.assertCurrent,
        ),
      },
    ],
  });
  if (!executed.ok) {
    return executed;
  }
  const outcome = executed.outcomes[0]!;
  if (!outcome.ok) {
    return outcome;
  }
  const prepared = executed.preparedByIndex[0]!;
  const result = await projectSessionPatchResult({
    canonicalKey: prepared.canonicalKey,
    cfg: executed.cfg,
    entry: outcome.entry,
    modelCatalogByAgent: executed.modelCatalogByAgent,
    storePath: prepared.storePath,
    targetAgentId: prepared.targetAgentId,
  });
  let continuation: SessionsPatchActiveRunOutcome["continuation"];
  if (
    isExecutionAuthorityPatch(params.patch) &&
    params.patch.activeRunPolicy === "stop-and-continue" &&
    prepared.activeRunPreparation?.stopped === true
  ) {
    continuation = await launchSessionPatchContinuation({
      agentId: prepared.targetAgentId,
      client: params.client,
      context: params.context,
      req: params.req,
      sessionId: outcome.entry.sessionId,
      sessionKey: prepared.canonicalKey,
      assertCurrent: () => {
        const current = resolveGatewaySessionStoreTargetWithStore({
          cfg: executed.cfg,
          key: prepared.canonicalKey,
          agentId: prepared.targetAgentId,
          exactRead: true,
        }).store[prepared.canonicalKey];
        params.sessionMutationAuthorization?.assertCurrent();
        if (
          current?.sessionId !== outcome.entry.sessionId ||
          current?.lifecycleRevision !== outcome.entry.lifecycleRevision
        ) {
          throw new Error("Session changed before continuation launch.");
        }
      },
    });
  }
  const activeRun = activeRunPatchResult({
    auditNote: prepared.activeRunAuditNote ?? "failed",
    fullPatch: prepared.fullPatch,
    stopped:
      prepared.activeRunPreparation?.stopped === true || prepared.archivePreparation !== undefined,
    ...(continuation ? { continuation } : {}),
  });
  return { ok: true, result: activeRun ? { ...result, activeRun } : result };
}
