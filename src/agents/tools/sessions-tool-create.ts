import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionsCreateResult } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { bindActiveOperatorTurnAuthority } from "../cron-creator-authority-context.js";
import {
  jsonResult,
  readToolStringParam,
  ToolAuthorizationError,
  ToolInputError,
} from "./common.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import { createAgentToAgentPolicy, createSessionVisibilityChecker } from "./sessions-access.js";
import { resolveSessionToolContext } from "./sessions-helpers.js";

export const SESSION_CREATE_PERMISSION_MODES = [
  "read-only",
  "guarded",
  "workspace",
  "full",
] as const;
const PERMISSION_MODE_VALUES: ReadonlySet<string> = new Set(SESSION_CREATE_PERMISSION_MODES);

export function prepareDetachedSessionCreation(options: {
  agentSessionKey?: string;
  requesterAgentIdOverride?: string;
  runId?: string;
  config?: OpenClawConfig;
  callGateway: AgentToolGatewayRequestCaller;
}) {
  const authority = bindActiveOperatorTurnAuthority(options.runId);
  if (!authority) {
    return undefined;
  }
  const context = resolveSessionToolContext(options);
  const requesterAgentId = resolveSessionAgentId({
    config: context.cfg,
    sessionKey: context.effectiveRequesterKey,
    agentId: options.requesterAgentIdOverride,
  });
  const createdSessionIds = new Map<string, string>();
  const unregister = createSessionVisibilityChecker.registerScopedAccessProvider((request) => {
    if (
      request.action !== "send" ||
      request.requesterSessionKey !== context.effectiveRequesterKey
    ) {
      return undefined;
    }
    authority.assertActive();
    const expectedSessionId = createdSessionIds.get(request.targetSessionKey);
    return expectedSessionId ? { expectedSessionId } : undefined;
  });
  authority.onClose(unregister);
  const admin = authority.source === "local";

  return {
    admin,
    execute: async (params: Record<string, unknown>) => {
      authority.assertActive();
      const permissionMode = readToolStringParam(params, "permissionMode") ?? "guarded";
      if (!PERMISSION_MODE_VALUES.has(permissionMode)) {
        throw new ToolInputError("permissionMode must be read-only, guarded, workspace, or full");
      }
      if (permissionMode === "full" && !admin) {
        throw new ToolAuthorizationError(
          "Ask an administrator to create a full session from a direct local operator turn, or choose guarded, workspace, or read-only.",
        );
      }
      const agentId =
        normalizeOptionalString(readToolStringParam(params, "agentId")) ?? requesterAgentId;
      if (
        agentId !== requesterAgentId &&
        !createAgentToAgentPolicy(context.cfg).isAllowed(requesterAgentId, agentId)
      ) {
        throw new ToolAuthorizationError(
          "Cross-agent session creation requires tools.agentToAgent.enabled and an allow rule for both agents.",
        );
      }
      const label = normalizeOptionalString(readToolStringParam(params, "label"));
      const result = await options.callGateway<SessionsCreateResult>({
        method: "sessions.create",
        params: { agentId, ...(label ? { label } : {}), permissionMode },
        sessionCreation: {
          via: "operator",
          actor: { type: "agent", id: requesterAgentId },
          detachedAuthority: authority.detachedSessionAuthority,
        },
      });
      if (!result.sessionId) {
        throw new ToolInputError("Session creation did not return its durable session identity");
      }
      createdSessionIds.set(result.key, result.sessionId);
      return jsonResult({
        status: "created",
        key: result.key,
        sessionId: result.sessionId,
        mode: permissionMode,
        nextStep: "Use sessions_send with this key to start work in the detached session.",
      });
    },
  };
}
