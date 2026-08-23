import type { SessionsPatchParams } from "../../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { disableCronJobsBoundToSessions } from "../../cron/job-session-bindings.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { ensureSessionGroupRegistered } from "../session-groups.js";
import { triggerSessionPatchHook } from "../session-patch-hooks.js";
import { appendSessionAudit } from "./session-audit.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { persistSessionPatchModelSelection } from "./sessions-patch-model-selection.js";
import { sessionLog } from "./sessions-shared.js";
import type { GatewayRequestContext } from "./types.js";

export async function appendSessionPatchAudits(params: {
  cfg: OpenClawConfig;
  manageActiveRunPolicy: boolean;
  targets: Array<{
    activeRunPreparation?: { stopped: boolean };
    canonicalKey: string;
    executionAuthorityFields: string[];
    executionAuthorityPatch: boolean;
    fullPatch: SessionsPatchParams;
    outcome?: { ok: boolean; entry?: SessionEntry };
    setActiveRunAuditNote: (value: "appended" | "failed") => void;
    storePath: string;
    targetAgentId: string;
  }>;
}): Promise<void> {
  for (const target of params.targets) {
    const outcome = target.outcome;
    if (!outcome?.ok || !outcome.entry) {
      continue;
    }
    if (!params.manageActiveRunPolicy || !target.executionAuthorityPatch) {
      continue;
    }
    const visibleFields = target.executionAuthorityFields.join(",");
    try {
      await appendSessionAudit({
        cfg: params.cfg,
        target: {
          agentId: target.targetAgentId,
          entry: outcome.entry,
          sessionKey: target.canonicalKey,
          storePath: target.storePath,
        },
        text: target.activeRunPreparation?.stopped
          ? `execution policy updated (${visibleFields}) after active work was stopped`
          : `execution policy updated (${visibleFields}) while the session was idle`,
        now: Date.now(),
      });
      target.setActiveRunAuditNote("appended");
    } catch (error) {
      target.setActiveRunAuditNote("failed");
      sessionLog.warn(
        `sessions.patch: execution-policy audit note failed for ${target.canonicalKey}; patch kept: ${formatErrorMessage(error)}`,
      );
    }
  }
}

export async function applySessionPatchEffects(params: {
  callerCanManageCron: boolean;
  callerScopes: string[];
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  targets: Array<{
    canonicalKey: string;
    fullPatch: SessionsPatchParams;
    outcome?: { ok: boolean; entry?: SessionEntry };
    requestedAgentId?: string;
    targetAgentId: string;
  }>;
}): Promise<void> {
  let patched = false;
  const archivedSessionKeys = new Set<string>();
  for (const target of params.targets) {
    if (!target.outcome?.ok || !target.outcome.entry) {
      continue;
    }
    triggerSessionPatchHook({
      cfg: params.cfg,
      sessionEntry: target.outcome.entry,
      sessionKey: target.canonicalKey,
      patch: target.fullPatch,
    });
    persistSessionPatchModelSelection({
      cfg: params.cfg,
      callerScopes: params.callerScopes,
      entry: target.outcome.entry,
      patch: target.fullPatch,
      sessionKey: target.canonicalKey,
      targetAgentId: target.targetAgentId,
    });
    emitSessionsChanged(params.context, {
      sessionKey: target.canonicalKey,
      ...(target.requestedAgentId ? { agentId: target.requestedAgentId } : {}),
      reason: "patch",
    });
    patched = true;
    if (target.fullPatch.archived === true) {
      archivedSessionKeys.add(target.canonicalKey);
    }
  }

  const category = params.targets[0]?.fullPatch.category;
  if (patched && typeof category === "string" && category.trim()) {
    if (ensureSessionGroupRegistered(category)) {
      emitSessionsChanged(params.context, { reason: "groups" });
    }
  }
  if (!params.callerCanManageCron || archivedSessionKeys.size === 0) {
    return;
  }
  try {
    const disabledBySession = await disableCronJobsBoundToSessions({
      cron: params.context.cron,
      cfg: params.cfg,
      sessionKeys: [...archivedSessionKeys],
    });
    for (const [sessionKey, disabledJobIds] of disabledBySession) {
      if (disabledJobIds.length > 0) {
        sessionLog.info(
          `sessions.patch: disabled cron jobs bound to archived session ${sessionKey}: ${disabledJobIds.join(", ")}`,
        );
      }
    }
  } catch (error) {
    sessionLog.warn(
      `sessions.patch: failed to disable cron jobs for archived sessions: ${formatErrorMessage(error)}`,
    );
  }
}
