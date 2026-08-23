import type { SessionEntry } from "../../config/sessions.js";
import type {
  SessionCreatedActor,
  SessionCreatedVia,
} from "../../config/sessions/session-entry-provenance.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import { appendSessionAudit } from "./session-audit.js";
import { sessionLog } from "./sessions-shared.js";

export type TrustedSessionCreation = {
  via: SessionCreatedVia;
  actor?: SessionCreatedActor;
  /** Exact spawning session retained separately from the stable actor identity. */
  requesterSessionKey?: string;
  /** Immutable completion recipient for a spawn-owned visible session. */
  completionOwnerSessionKey?: string;
  /** Effective caller tool-policy snapshot for an in-process visible spawn. */
  inheritedToolPolicy?: {
    version: 1;
    allow: string[];
    deny: string[];
  };
  /** Closure-bound native-spawn grant; never serialized or model-authored. */
  fullAccessAdmission?: Readonly<{
    parentSessionId: string;
    parentLifecycleRevision?: string;
    assertActive: () => void;
  }>;
  /** Native child state committed by createGatewaySession, not public RPC input. */
  initialSpawnEntry?: Pick<
    SessionEntry,
    | "completionOwnerSessionKey"
    | "fastMode"
    | "inheritedToolAllow"
    | "inheritedToolDeny"
    | "inheritedToolPolicyVersion"
    | "model"
    | "modelOverride"
    | "modelOverrideFallbackOriginModel"
    | "modelOverrideFallbackOriginProvider"
    | "modelOverrideRouteResolution"
    | "modelOverrideSource"
    | "modelProvider"
    | "providerOverride"
    | "subagentControlScope"
    | "subagentRole"
    | "swarmCollector"
    | "swarmGroupId"
    | "swarmOutputSchema"
    | "thinkingLevel"
  > & { spawnedWorkspaceDir?: string; spawnedCwd?: string };
};

/**
 * Structural subset of GatewayClient; a leaf contract so shared-types.ts can
 * import TrustedSessionCreation without a type cycle back through this module.
 */
type SessionCreationClient = {
  authenticatedUserProfile?: { profileId?: string } | null;
  internal?: {
    syntheticClient?: true;
    sessionCreation?: TrustedSessionCreation;
    agentRuntimeIdentity?: AgentRuntimeIdentity;
  };
};

export function resolveOperatorSessionCreation(
  client: SessionCreationClient | null | undefined,
  options: { allowTrustedHint?: boolean } = {},
): TrustedSessionCreation {
  if (options.allowTrustedHint && client?.internal?.sessionCreation) {
    return client.internal.sessionCreation;
  }
  const agentRuntimeIdentity = client?.internal?.agentRuntimeIdentity;
  if (options.allowTrustedHint && agentRuntimeIdentity?.sessionSpawnContext) {
    return {
      via: "spawn",
      actor: { type: "agent", id: agentRuntimeIdentity.agentId },
      requesterSessionKey: agentRuntimeIdentity.sessionKey,
      ...(agentRuntimeIdentity.sessionSpawnContext.completionOwnerSessionKey
        ? {
            completionOwnerSessionKey:
              agentRuntimeIdentity.sessionSpawnContext.completionOwnerSessionKey,
          }
        : {}),
      inheritedToolPolicy: agentRuntimeIdentity.sessionSpawnContext.inheritedToolPolicy,
      ...(agentRuntimeIdentity.sessionSpawnContext.initialSpawnEntry
        ? { initialSpawnEntry: agentRuntimeIdentity.sessionSpawnContext.initialSpawnEntry }
        : {}),
    };
  }
  const profileId = client?.authenticatedUserProfile?.profileId;
  // Profile linking can canonicalize this id after connection attach, so session
  // ownership follows the live trusted profile while audit keeps its frozen facts.
  return {
    via: "operator",
    ...(profileId ? { actor: { type: "human" as const, id: profileId } } : {}),
  };
}

export function resolveAgentRunSessionCreation(
  client: SessionCreationClient | null | undefined,
): TrustedSessionCreation {
  const actor = resolveOperatorSessionCreation(client).actor;
  return { via: "run", ...(actor ? { actor } : {}) };
}

export async function appendFullAccessDelegationAudit(params: {
  cfg: OpenClawConfig;
  creation: TrustedSessionCreation;
  target: { agentId: string; entry: SessionEntry; sessionKey: string; storePath: string };
}): Promise<void> {
  const admission = params.creation.fullAccessAdmission;
  if (!admission) {
    return;
  }
  admission.assertActive();
  try {
    await appendSessionAudit({
      cfg: params.cfg,
      target: params.target,
      text: "Created with explicitly delegated full access from its parent session.",
      now: Date.now(),
    });
  } catch (error) {
    sessionLog.warn(`failed to append full-access delegation note: ${formatErrorMessage(error)}`);
  }
  admission.assertActive();
}
