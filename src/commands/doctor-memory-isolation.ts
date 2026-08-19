import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { listAgentIds, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  disableMemoryShadowReadOnlyMode,
  enableMemoryShadowReadOnlyMode,
  resolveMemoryIsolationMode,
  type MemoryIsolationMode,
} from "../plugins/memory-cutover.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { withDoctorSqliteMaintenanceLock } from "./doctor-sqlite-maintenance-lock.js";

export type DoctorMemoryIsolationAction = "status" | "shadow-read-only" | "legacy";

export type DoctorMemoryIsolationReport = Readonly<{
  agentId: string;
  mode: MemoryIsolationMode;
  restartRequired: boolean;
}>;

function resolveDoctorMemoryIsolationAgent(params: {
  agentId?: string;
  cfg: OpenClawConfig;
}): string {
  const agentId = normalizeOptionalString(params.agentId) ?? resolveDefaultAgentId(params.cfg);
  if (!listAgentIds(params.cfg).includes(agentId)) {
    throw new Error(`Unknown configured agent id "${agentId}".`);
  }
  return agentId;
}

/**
 * Doctor owns the only P1C enablement path. It persists one reversible, verified posture and
 * deliberately does not create a Phase 6 cutover marker or claim two-subject confinement.
 */
export async function runDoctorMemoryIsolation(params: {
  action: DoctorMemoryIsolationAction;
  agentId?: string;
  cfg?: OpenClawConfig;
  nowMs?: number;
}): Promise<DoctorMemoryIsolationReport> {
  const cfg = params.cfg ?? getRuntimeConfig();
  const agentId = resolveDoctorMemoryIsolationAgent({ agentId: params.agentId, cfg });
  switch (params.action) {
    case "status":
      return { agentId, mode: resolveMemoryIsolationMode(agentId), restartRequired: false };
    case "shadow-read-only":
      return await withDoctorSqliteMaintenanceLock({
        operation: "memory isolation shadow-read-only",
        protectedPaths: [resolveOpenClawAgentSqlitePath({ agentId })],
        run: () => ({
          agentId,
          mode: enableMemoryShadowReadOnlyMode({ agentId, nowMs: params.nowMs }),
          restartRequired: true,
        }),
      });
    case "legacy":
      return await withDoctorSqliteMaintenanceLock({
        operation: "memory isolation legacy",
        protectedPaths: [resolveOpenClawAgentSqlitePath({ agentId })],
        run: () => ({
          agentId,
          mode: disableMemoryShadowReadOnlyMode({ agentId }),
          restartRequired: true,
        }),
      });
  }
}
