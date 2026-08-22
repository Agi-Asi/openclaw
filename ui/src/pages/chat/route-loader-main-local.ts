import type { SessionPathTarget } from "../../app-session-route-paths.ts";
import {
  DEFAULT_MAIN_KEY,
  buildAgentMainSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiDefaultAgentId,
} from "../../lib/sessions/session-key.ts";
import type { SessionRouteContext } from "./route-loader-context.ts";

/**
 * Pre-hello, an agent-home URL for this browser's own last-active agent
 * resolves from the persisted key instead of waiting for the handshake; hello
 * reconciliation and the delta reload stay authoritative. Returns null when
 * the gateway must stay the authority (connected, foreign agent, custom main).
 */
export function resolveLocalMainSessionTarget(
  context: SessionRouteContext,
  target: Extract<SessionPathTarget, { kind: "main" }>,
): { sessionKey: string } | null {
  if (context.gateway.snapshot.phase === "connected") {
    return null;
  }
  const persistedKey = context.gateway.snapshot.sessionKey.trim();
  const persistedParsed = parseAgentSessionKey(persistedKey);
  if (
    persistedParsed &&
    persistedParsed.rest === DEFAULT_MAIN_KEY &&
    normalizeAgentId(target.agentId) === normalizeAgentId(persistedParsed.agentId)
  ) {
    return { sessionKey: persistedKey };
  }
  if (
    !persistedParsed &&
    persistedKey.toLowerCase() === DEFAULT_MAIN_KEY &&
    normalizeAgentId(target.agentId) ===
      resolveUiDefaultAgentId({
        agentsList: context.agents.state.agentsList,
        hello: context.gateway.snapshot.hello,
      })
  ) {
    return {
      sessionKey: buildAgentMainSessionKey({
        agentId: target.agentId,
        mainKey: DEFAULT_MAIN_KEY,
      }),
    };
  }
  return null;
}
