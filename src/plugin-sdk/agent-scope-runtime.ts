// Narrow agent-scope helpers for control-plane and migration paths.

import {
  resolveSoleAgentId,
  tryResolveSoleAgentId,
  type AgentSelectionContext,
} from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.js";

export {
  listAgentIds,
  resolveAgentConfig,
  resolveAgentDir,
  resolveAmbientOwnerAgentId,
} from "../agents/agent-scope-config.js";
export { resolveSoleAgentId, tryResolveSoleAgentId };
export { resolveSessionAgentId, resolveSessionAgentIds } from "../agents/agent-scope.js";

/**
 * @deprecated Use resolveSoleAgentId for explicit selection or resolveAmbientOwnerAgentId
 * for ambient work. Remove after the next major Plugin SDK compatibility window.
 */
export function resolveDefaultAgentId(
  config: OpenClawConfig,
  context?: AgentSelectionContext,
): string {
  return resolveSoleAgentId(config, context);
}

/**
 * @deprecated Use tryResolveSoleAgentId for explicit selection. Remove after the
 * next major Plugin SDK compatibility window.
 */
export function tryResolveDefaultAgentId(config: OpenClawConfig): string | undefined {
  return tryResolveSoleAgentId(config);
}
