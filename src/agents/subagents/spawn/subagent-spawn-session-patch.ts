import { isDeepStrictEqual } from "node:util";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  inheritedToolAllowPatch,
  inheritedToolDenyPatch,
  normalizeInheritedToolAllowlist,
  normalizeInheritedToolDenylist,
} from "../../inherited-tool-deny.js";
import type { FullAccessDelegationAdmission } from "../../tools/sessions-spawn-full-access.js";
import type { SpawnSubagentResult } from "./subagent-spawn-contract.js";
import { getSubagentSpawnDeps } from "./subagent-spawn-deps.js";
import { splitModelRef } from "./subagent-spawn-plan.js";

function buildDirectChildSessionPatch(patch: Record<string, unknown>): Partial<SessionEntry> {
  const entry: Partial<SessionEntry> = {};
  const spawnDepth = patch.spawnDepth;
  if (typeof spawnDepth === "number" && Number.isFinite(spawnDepth) && spawnDepth >= 0) {
    entry.spawnDepth = Math.floor(spawnDepth);
  }
  if (patch.subagentRole === "orchestrator" || patch.subagentRole === "leaf") {
    entry.subagentRole = patch.subagentRole;
  }
  if (patch.subagentControlScope === "children" || patch.subagentControlScope === "none") {
    entry.subagentControlScope = patch.subagentControlScope;
  }
  if (patch.inheritedToolPolicyVersion === 1) {
    entry.inheritedToolPolicyVersion = 1;
  }
  if (patch.incognito === true) {
    entry.incognito = true;
  }
  if (typeof patch.spawnedBy === "string" && patch.spawnedBy.trim()) {
    entry.spawnedBy = patch.spawnedBy.trim();
  }
  if (
    typeof patch.completionOwnerSessionKey === "string" &&
    patch.completionOwnerSessionKey.trim()
  ) {
    entry.completionOwnerSessionKey = patch.completionOwnerSessionKey.trim();
  }
  if (typeof patch.parentSessionKey === "string" && patch.parentSessionKey.trim()) {
    entry.parentSessionKey = patch.parentSessionKey.trim();
  }
  if (typeof patch.spawnedWorkspaceDir === "string" && patch.spawnedWorkspaceDir.trim()) {
    entry.spawnedWorkspaceDir = patch.spawnedWorkspaceDir.trim();
  }
  if (typeof patch.spawnedCwd === "string" && patch.spawnedCwd.trim()) {
    entry.spawnedCwd = patch.spawnedCwd.trim();
  }
  const inheritedToolDeny = normalizeInheritedToolDenylist(patch.inheritedToolDeny);
  if (inheritedToolDeny.length > 0) {
    entry.inheritedToolDeny = inheritedToolDeny;
  }
  const inheritedToolAllow = normalizeInheritedToolAllowlist(patch.inheritedToolAllow);
  if (inheritedToolAllow.length > 0) {
    entry.inheritedToolAllow = inheritedToolAllow;
  }
  if (typeof patch.thinkingLevel === "string" && patch.thinkingLevel.trim()) {
    entry.thinkingLevel = patch.thinkingLevel.trim();
  }
  if (patch.fastMode === true || patch.fastMode === false || patch.fastMode === "auto") {
    entry.fastMode = patch.fastMode;
  }
  if (typeof patch.swarmGroupId === "string" && patch.swarmGroupId.trim()) {
    entry.swarmGroupId = patch.swarmGroupId.trim();
  }
  if (patch.swarmCollector === true) {
    entry.swarmCollector = true;
  }
  if (patch.swarmOutputSchema && typeof patch.swarmOutputSchema === "object") {
    entry.swarmOutputSchema = asNullableRecord(patch.swarmOutputSchema) ?? undefined;
  }
  if (typeof patch.model === "string" && patch.model.trim()) {
    const { provider, model } = splitModelRef(patch.model.trim());
    if (model) {
      entry.model = model;
      entry.modelOverride = model;
      entry.modelOverrideSource = patch.modelOverrideSource === "auto" ? "auto" : "user";
      entry.modelOverrideRouteResolution = "resolved";
      const fallbackOriginProvider = normalizeOptionalString(
        patch.modelOverrideFallbackOriginProvider,
      );
      const fallbackOriginModel = normalizeOptionalString(patch.modelOverrideFallbackOriginModel);
      if (fallbackOriginProvider && fallbackOriginModel) {
        entry.modelOverrideFallbackOriginProvider = fallbackOriginProvider;
        entry.modelOverrideFallbackOriginModel = fallbackOriginModel;
      }
      if (provider) {
        entry.modelProvider = provider;
        entry.providerOverride = provider;
      }
    }
  }
  return entry;
}

function projectCreatedSessionEntry(
  value: Record<string, unknown> | null,
): SessionEntry | undefined {
  return typeof value?.sessionId === "string" &&
    value.sessionId.length > 0 &&
    typeof value.updatedAt === "number"
    ? // SAFETY: sessions.create schema-validates the row; this boundary verifies required identity fields before projection.
      (value as unknown as SessionEntry)
    : undefined;
}

export function loadSubagentConfig() {
  return getSubagentSpawnDeps().getRuntimeConfig();
}

export async function createInitialSubagentSession(params: {
  cfg: OpenClawConfig;
  targetAgentId: string;
  childSessionKey: string;
  incognito: boolean;
  requesterInternalKey: string;
  requesterAgentId: string;
  completionOwnerSessionKey: string;
  spawnedWorkspaceDir?: string;
  spawnedCwd?: string;
  admissionPatch?: Record<string, unknown>;
  inheritedToolAllowlist?: string[];
  inheritedToolDenylist?: string[];
  modelPatch: Record<string, unknown>;
  swarmGroupId?: string;
  collect: boolean;
  outputSchema?: Record<string, unknown>;
  childDepth: number;
  permissionMode?: "full";
  fullAccessAdmission?: FullAccessDelegationAdmission;
}): Promise<{ status: "ok"; entry?: SessionEntry } | { status: "error"; error: string }> {
  const initialChildSessionPatch: Record<string, unknown> = {
    spawnedBy: params.requesterInternalKey,
    completionOwnerSessionKey: params.completionOwnerSessionKey,
    // Navigation and control lineage commit with the creation stamp so a
    // launch failure cannot leave a durable but parentless child row.
    parentSessionKey: params.requesterInternalKey,
    ...(params.spawnedWorkspaceDir ? { spawnedWorkspaceDir: params.spawnedWorkspaceDir } : {}),
    ...(params.spawnedCwd ? { spawnedCwd: params.spawnedCwd } : {}),
    ...params.admissionPatch,
    inheritedToolPolicyVersion: 1,
    ...inheritedToolAllowPatch(params.inheritedToolAllowlist),
    ...inheritedToolDenyPatch(params.inheritedToolDenylist),
    ...params.modelPatch,
    ...(params.swarmGroupId ? { swarmGroupId: params.swarmGroupId } : {}),
    ...(params.collect ? { swarmCollector: true } : {}),
    ...(params.outputSchema ? { swarmOutputSchema: params.outputSchema } : {}),
    ...(params.incognito ? { incognito: true } : {}),
  };
  try {
    const initialSpawnEntry = buildDirectChildSessionPatch(initialChildSessionPatch);
    params.fullAccessAdmission?.assertActive();
    const response = await getSubagentSpawnDeps().createGatewaySession(
      "sessions.create",
      {
        key: params.childSessionKey,
        agentId: params.targetAgentId,
        parentSessionKey: params.requesterInternalKey,
        spawnDepth: params.childDepth,
        ...(params.incognito ? { incognito: true } : {}),
        ...(params.permissionMode ? { permissionMode: params.permissionMode } : {}),
      },
      {
        via: "spawn",
        actor: { type: "agent", id: params.requesterAgentId },
        requesterSessionKey: params.requesterInternalKey,
        completionOwnerSessionKey: params.completionOwnerSessionKey,
        inheritedToolPolicy: {
          version: 1,
          allow: params.inheritedToolAllowlist ?? [],
          deny: params.inheritedToolDenylist ?? [],
        },
        initialSpawnEntry,
        ...(params.fullAccessAdmission ? { fullAccessAdmission: params.fullAccessAdmission } : {}),
      },
    );
    const entry = asNullableRecord(asNullableRecord(response)?.entry);
    const expected = Object.entries(initialSpawnEntry);
    if (!entry || expected.some(([key, value]) => !isDeepStrictEqual(entry[key], value))) {
      return { status: "error", error: "child session creation did not commit spawn state" };
    }
    const createdEntry = projectCreatedSessionEntry(entry);
    return createdEntry
      ? { status: "ok", entry: createdEntry }
      : { status: "error", error: "child session creation returned no session identity" };
  } catch (err) {
    const message = err instanceof Error ? err.message : typeof err === "string" ? err : "error";
    return { status: "error", error: `child session creation failed: ${message}` };
  }
}

export async function rejectClosedFullAccessSpawn(params: {
  admission?: FullAccessDelegationAdmission;
  childSessionKey: string;
  cleanup: (emitLifecycleHooks?: boolean) => Promise<unknown>;
  emitLifecycleHooks?: boolean;
}): Promise<SpawnSubagentResult | undefined> {
  try {
    params.admission?.assertActive();
    return undefined;
  } catch (error) {
    await params.cleanup(params.emitLifecycleHooks);
    return {
      status: "forbidden",
      error: error instanceof Error ? error.message : "full-access delegation authority changed",
      childSessionKey: params.childSessionKey,
    };
  }
}
