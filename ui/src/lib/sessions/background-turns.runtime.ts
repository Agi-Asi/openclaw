import type { ChatEvent } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { GatewayEventFrame } from "../../api/gateway.ts";
import type { SessionCreateOutcome, SessionCreateParams } from "./create.ts";
import type { SessionGateway } from "./session-capability.ts";
import { areUiSessionKeysEquivalent, normalizeAgentId } from "./session-key.ts";

const MAX_BUFFERED_TERMINALS = 32;

type BackgroundTerminalEvent = Extract<ChatEvent, { state: "aborted" | "error" | "final" }>;

type BackgroundLaunch = {
  agentId?: string;
  key: string;
  runId: string;
};

export type SessionBackgroundTurnOutcome =
  | (BackgroundLaunch & { status: "completed" })
  | (BackgroundLaunch & {
      status: "aborted";
      errorMessage?: string;
    })
  | (BackgroundLaunch & {
      status: "error";
      errorKind?: Extract<BackgroundTerminalEvent, { state: "error" }>["errorKind"];
      errorMessage?: string;
    })
  | {
      agentId?: string;
      key: string;
      status: "initial-turn-rejected";
      errorMessage: string;
    }
  | {
      agentId?: string;
      key: string;
      status: "initial-turn-idle";
    }
  | {
      agentId?: string;
      key: string;
      status: "tracking-interrupted";
      reason: "connection-replaced" | "missing-run-id";
    };

type BackgroundCreate = (params: SessionCreateParams) => Promise<SessionCreateOutcome | null>;

function readTerminal(event: GatewayEventFrame): BackgroundTerminalEvent | null {
  if (event.event !== "chat" || !event.payload || typeof event.payload !== "object") {
    return null;
  }
  // SAFETY: The payload is object-checked; only optional scalar fields are read below.
  const payload = event.payload as Partial<BackgroundTerminalEvent>;
  if (
    typeof payload.runId !== "string" ||
    typeof payload.sessionKey !== "string" ||
    (payload.state !== "final" && payload.state !== "aborted" && payload.state !== "error") ||
    (payload.state === "final" && payload.yielded === true)
  ) {
    return null;
  }
  // SAFETY: Required terminal identity and closed state are checked; other fields are optional.
  return payload as BackgroundTerminalEvent;
}

function launchMatchesTerminal(
  launch: BackgroundLaunch,
  terminal: BackgroundTerminalEvent,
): boolean {
  if (
    launch.runId !== terminal.runId ||
    !areUiSessionKeysEquivalent(launch.key, terminal.sessionKey)
  ) {
    return false;
  }
  return !(
    launch.agentId &&
    terminal.agentId &&
    normalizeAgentId(launch.agentId) !== normalizeAgentId(terminal.agentId)
  );
}

function terminalOutcome(
  launch: BackgroundLaunch,
  terminal: BackgroundTerminalEvent,
): SessionBackgroundTurnOutcome {
  if (terminal.state === "final") {
    return { ...launch, status: "completed" };
  }
  if (terminal.state === "aborted") {
    return {
      ...launch,
      status: "aborted",
      ...(terminal.errorMessage ? { errorMessage: terminal.errorMessage } : {}),
    };
  }
  return {
    ...launch,
    status: "error",
    ...(terminal.errorKind ? { errorKind: terminal.errorKind } : {}),
    ...(terminal.errorMessage ? { errorMessage: terminal.errorMessage } : {}),
  };
}

export function createSessionBackgroundTurns(
  create: BackgroundCreate,
  gateway?: Pick<SessionGateway, "snapshot" | "subscribe" | "subscribeEvents">,
) {
  const listeners = new Set<(outcome: SessionBackgroundTurnOutcome) => void>();
  const launchesByRunId = new Map<string, BackgroundLaunch[]>();
  const pendingCreates = new Set<symbol>();
  const bufferedTerminals: BackgroundTerminalEvent[] = [];
  let connectionGeneration = 0;

  const emit = (outcome: SessionBackgroundTurnOutcome) => {
    for (const listener of listeners) {
      listener(outcome);
    }
  };

  const consumeTerminal = (terminal: BackgroundTerminalEvent): boolean => {
    const candidates = launchesByRunId.get(terminal.runId);
    const index = candidates?.findIndex((launch) => launchMatchesTerminal(launch, terminal)) ?? -1;
    if (!candidates || index < 0) {
      return false;
    }
    const [launch] = candidates.splice(index, 1);
    if (candidates.length === 0) {
      launchesByRunId.delete(terminal.runId);
    }
    if (launch) {
      emit(terminalOutcome(launch, terminal));
    }
    return true;
  };

  const clearUnusedTerminals = () => {
    if (pendingCreates.size === 0) {
      bufferedTerminals.length = 0;
    }
  };

  const createBackground = async (
    params: SessionCreateParams,
  ): Promise<SessionCreateOutcome | null> => {
    const token = Symbol("background-create");
    const generation = connectionGeneration;
    pendingCreates.add(token);
    const result = await create(params);
    pendingCreates.delete(token);
    const agentId = params.agentId?.trim() || undefined;
    if (result?.initialRun.status === "rejected") {
      emit({
        key: result.key,
        ...(agentId ? { agentId } : {}),
        status: "initial-turn-rejected",
        errorMessage: result.initialRun.error,
      });
      clearUnusedTerminals();
      return result;
    }
    if (result?.initialRun.status === "idle") {
      emit({
        key: result.key,
        ...(agentId ? { agentId } : {}),
        status: "initial-turn-idle",
      });
      clearUnusedTerminals();
      return result;
    }
    if (!result) {
      clearUnusedTerminals();
      return null;
    }
    if (generation !== connectionGeneration) {
      emit({
        key: result.key,
        ...(agentId ? { agentId } : {}),
        status: "tracking-interrupted",
        reason: "connection-replaced",
      });
      clearUnusedTerminals();
      return result;
    }
    const runId = result.initialRun.runId?.trim();
    if (!runId) {
      emit({
        key: result.key,
        ...(agentId ? { agentId } : {}),
        status: "tracking-interrupted",
        reason: "missing-run-id",
      });
      clearUnusedTerminals();
      return result;
    }
    const launch = { key: result.key, runId, ...(agentId ? { agentId } : {}) };
    const candidates = launchesByRunId.get(runId) ?? [];
    candidates.push(launch);
    launchesByRunId.set(runId, candidates);
    const bufferedIndex = bufferedTerminals.findIndex((terminal) =>
      launchMatchesTerminal(launch, terminal),
    );
    if (bufferedIndex >= 0) {
      const [terminal] = bufferedTerminals.splice(bufferedIndex, 1);
      if (terminal) {
        consumeTerminal(terminal);
      }
    }
    clearUnusedTerminals();
    return result;
  };

  const observe = (event: GatewayEventFrame) => {
    const terminal = readTerminal(event);
    if (!terminal || consumeTerminal(terminal) || pendingCreates.size === 0) {
      return;
    }
    if (bufferedTerminals.length >= MAX_BUFFERED_TERMINALS) {
      bufferedTerminals.shift();
    }
    bufferedTerminals.push(terminal);
  };

  const interrupt = () => {
    connectionGeneration += 1;
    for (const launches of launchesByRunId.values()) {
      for (const launch of launches) {
        emit({ ...launch, status: "tracking-interrupted", reason: "connection-replaced" });
      }
    }
    launchesByRunId.clear();
    bufferedTerminals.length = 0;
  };

  let gatewayClient = gateway?.snapshot.client;
  const stopGateway = gateway?.subscribe((snapshot) => {
    if (snapshot.client !== gatewayClient) {
      gatewayClient = snapshot.client;
      interrupt();
    }
  });
  const stopEvents = gateway?.subscribeEvents(observe);

  return {
    create: createBackground,
    observe,
    interrupt,
    subscribe(listener: (outcome: SessionBackgroundTurnOutcome) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      stopGateway?.();
      stopEvents?.();
      launchesByRunId.clear();
      pendingCreates.clear();
      bufferedTerminals.length = 0;
      listeners.clear();
    },
  };
}
