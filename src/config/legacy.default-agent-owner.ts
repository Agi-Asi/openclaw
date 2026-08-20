import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { tryResolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "./types.openclaw.js";

export function resolveSessionStoreCompatibilityAgentId(config: OpenClawConfig): string {
  const persistedAgentId = config.agents?.defaults?.sessionStore?.agentId?.trim();
  return persistedAgentId
    ? normalizeAgentId(persistedAgentId)
    : (tryResolveAmbientOwnerAgentId(config) ?? "main");
}
