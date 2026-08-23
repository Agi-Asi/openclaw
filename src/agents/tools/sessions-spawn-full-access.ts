import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getActiveAgentRunDelegatedAuthority } from "../../infra/agent-run-registry.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { getGatewayToolCallerIdentity } from "./gateway-caller-context.js";

export type FullAccessDelegationAdmission = Readonly<{
  parentSessionId: string;
  parentLifecycleRevision?: string;
  assertActive: () => void;
}>;

export function isFullAccessDelegationTurn(params: {
  permissionMode?: string;
  directUserTurnAuthority?: { assertActive: () => void };
}): boolean {
  if (params.permissionMode !== "full" || !params.directUserTurnAuthority) {
    return false;
  }
  try {
    params.directUserTurnAuthority.assertActive();
    return true;
  } catch {
    return false;
  }
}

export function createFullAccessDelegationAdmission(params: {
  cfg: OpenClawConfig;
  parentSessionKey: string;
  parentSessionId: string;
  parentLifecycleRevision?: string;
  signal?: AbortSignal;
}): FullAccessDelegationAdmission | undefined {
  const identity = getGatewayToolCallerIdentity();
  const operationalRunInstance = identity?.operationalRunInstance;
  const delegatedAuthority = operationalRunInstance
    ? getActiveAgentRunDelegatedAuthority(operationalRunInstance)
    : undefined;
  if (
    !identity ||
    identity.sessionKey !== params.parentSessionKey ||
    !operationalRunInstance ||
    !delegatedAuthority
  ) {
    return undefined;
  }
  const assertActive = () => {
    if (
      params.signal?.aborted ||
      getGatewayToolCallerIdentity() !== identity ||
      getActiveAgentRunDelegatedAuthority(operationalRunInstance) !== delegatedAuthority ||
      identity.receiptAuthority?.() === false
    ) {
      throw new Error("full-access delegation authority is no longer active");
    }
    const parentAgentId =
      parseAgentSessionKey(params.parentSessionKey)?.agentId ?? identity.agentId;
    const parentEntry = loadSessionEntryReadOnly({
      agentId: parentAgentId,
      sessionKey: params.parentSessionKey,
      storePath: resolveSessionStorePathCore(params.cfg.session?.store, { agentId: parentAgentId }),
    });
    if (
      parentEntry?.sessionId !== params.parentSessionId ||
      parentEntry.lifecycleRevision !== params.parentLifecycleRevision ||
      parentEntry.permissionMode !== "full" ||
      parentEntry.archivedAt !== undefined
    ) {
      throw new Error("full-access parent session authority changed");
    }
  };
  assertActive();
  return Object.freeze({
    parentSessionId: params.parentSessionId,
    ...(params.parentLifecycleRevision
      ? { parentLifecycleRevision: params.parentLifecycleRevision }
      : {}),
    assertActive,
  });
}
