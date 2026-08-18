import { AsyncLocalStorage } from "node:async_hooks";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isMemoryIsolationCutoverAgent } from "../plugins/memory-cutover.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { RunEmbeddedAgentParams } from "./embedded-agent-runner/run/params.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";
import { resolveSandboxConfigForAgent } from "./sandbox/config.js";
import { resolveSandboxRuntimeStatus } from "./sandbox/runtime-status.js";
import type { SandboxContext } from "./sandbox/types.js";

export type LocalTurnPlacementClaim = {
  sessionId: string;
  agentId?: string;
  sessionKey?: string;
  runId: string;
  /** Enforced memory cannot execute in the Gateway process or a local worker placement. */
  requiresProcessIsolation?: true;
};

export type SessionPlacementTurnParams = RunEmbeddedAgentParams & { sessionFile: string };

type SessionPlacementSandboxParams = {
  agentId: string;
  config?: OpenClawConfig;
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
};

export type SessionPlacementAdmissionProvider = {
  executeLocalTurn: <T>(claim: LocalTurnPlacementClaim, runLocal: () => Promise<T>) => Promise<T>;
  executeTurn: (
    claim: LocalTurnPlacementClaim,
    params: SessionPlacementTurnParams,
    runLocal: () => Promise<EmbeddedAgentRunResult>,
    onAdmitted?: () => void,
  ) => Promise<EmbeddedAgentRunResult>;
};

type PlacementSandboxAdmissionProvider = SessionPlacementAdmissionProvider & {
  resolveSandbox?: (params: SessionPlacementSandboxParams) => Promise<SandboxContext | null>;
};

type SessionPlacementAdmissionState = {
  provider?: PlacementSandboxAdmissionProvider;
};

// Runtime chunks share one provider. The identity guard keeps an older gateway
// shutdown from clearing a newer lifecycle's admission gate.
const state = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionPlacementAdmissionState"),
  (): SessionPlacementAdmissionState => ({}),
);
// Carry exact local-turn cleanup until the embedded handle captures it; never recover by session id.
const forcedTerminalSettlement = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionPlacementForcedTerminalSettlement"),
  () => new AsyncLocalStorage<() => Promise<void>>(),
);

export function withSessionPlacementForcedTerminalSettlement<T>(
  settle: () => Promise<void>,
  task: () => Promise<T>,
): Promise<T> {
  return forcedTerminalSettlement.run(settle, task);
}

export function resolveSessionPlacementForcedTerminalSettlement():
  | (() => Promise<void>)
  | undefined {
  return forcedTerminalSettlement.getStore();
}

export function installSessionPlacementAdmissionProvider(
  provider: SessionPlacementAdmissionProvider,
): () => void {
  state.provider = provider as PlacementSandboxAdmissionProvider;
  return () => {
    if (state.provider === provider) {
      state.provider = undefined;
    }
  };
}

function assertProcessIsolatedMemorySandbox(
  claim: LocalTurnPlacementClaim,
  params: SessionPlacementTurnParams,
): void {
  const agentId = claim.agentId ?? params.agentId;
  const sessionKey =
    params.sandboxSessionKey?.trim() ||
    claim.sessionKey?.trim() ||
    params.sessionKey?.trim() ||
    claim.sessionId;
  const sandbox = resolveSandboxConfigForAgent(params.config, agentId);
  const runtime = resolveSandboxRuntimeStatus({
    cfg: params.config,
    agentId,
    sessionKey,
  });
  // Authorized virtual memory projections are read-only Docker/Podman mounts. A process-isolated
  // agent must not silently run with an agent/shared scope, an unsandboxed main session, or a
  // transport that cannot mount the issued view.
  if (
    sandbox.scope !== "session" ||
    !runtime.sandboxed ||
    (sandbox.backend !== "docker" && sandbox.backend !== "podman")
  ) {
    throw new Error(
      "enforced memory requires a session-scoped Docker or Podman sandbox with authorized projections",
    );
  }
}

export async function withSessionPlacementTurnAdmission(
  claim: LocalTurnPlacementClaim,
  params: SessionPlacementTurnParams,
  task: () => Promise<EmbeddedAgentRunResult>,
  onAdmitted?: () => void,
): Promise<EmbeddedAgentRunResult> {
  let admitted = false;
  const admitTurn = () => {
    if (admitted) {
      return;
    }
    admitted = true;
    onAdmitted?.();
  };
  // Providers may execute locally or remotely; both must release queue ownership
  // only when their actual execution path has acquired its placement claim.
  const runAdmittedLocalTurn = () => {
    admitTurn();
    return task();
  };
  const requiresProcessIsolation = claim.requiresProcessIsolation === true;
  const admittedClaim = requiresProcessIsolation
    ? { ...claim, requiresProcessIsolation: true as const }
    : claim;
  const provider = state.provider;
  if (!provider) {
    if (requiresProcessIsolation) {
      throw new Error("enforced memory requires an isolated worker placement");
    }
    return await runAdmittedLocalTurn();
  }
  if (requiresProcessIsolation) {
    assertProcessIsolatedMemorySandbox(admittedClaim, params);
  }
  return await provider.executeTurn(admittedClaim, params, runAdmittedLocalTurn, admitTurn);
}

export async function withLocalSessionPlacementTurnAdmission<T>(
  claim: LocalTurnPlacementClaim,
  task: () => Promise<T>,
): Promise<T> {
  if (
    claim.requiresProcessIsolation === true ||
    (claim.agentId !== undefined && isMemoryIsolationCutoverAgent(claim.agentId))
  ) {
    throw new Error("enforced memory cannot execute through a local CLI placement");
  }
  const provider = state.provider;
  if (!provider) {
    return await task();
  }
  return await provider.executeLocalTurn(claim, task);
}

/** Resolves an authoritative sandbox only when the live placement owns remote execution. */
export async function resolveSessionPlacementSandbox(
  params: SessionPlacementSandboxParams,
): Promise<SandboxContext | null> {
  return (await state.provider?.resolveSandbox?.(params)) ?? null;
}
