import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";

// Missing terminal events are repaired by the next history load; caps bound
// the transient pre-reload state without turning this into a durable registry.
const MAX_TRACKED_RUNS_PER_SESSION = 32;

export type ChatSessionRunTrackerHost = {
  sessionKey: string;
  activeChatRunIdsBySession?: Map<string, Set<string>>;
};

function normalized(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function matchingSessionKey(candidate: string, sessionKeys: readonly string[]): boolean {
  return sessionKeys.some(
    (sessionKey) => candidate === sessionKey || areUiSessionKeysEquivalent(candidate, sessionKey),
  );
}

export function trackChatSessionRun(
  host: ChatSessionRunTrackerHost,
  runId: string | null | undefined,
): void {
  const run = normalized(runId);
  const sessionKey = normalized(host.sessionKey);
  if (!run || !sessionKey) {
    return;
  }
  const tracker = (host.activeChatRunIdsBySession ??= new Map());
  let runs = tracker.get(sessionKey);
  if (!runs) {
    tracker.clear();
    runs = new Set();
    tracker.set(sessionKey, runs);
  }
  if (runs.size >= MAX_TRACKED_RUNS_PER_SESSION) {
    const oldestRun = runs.values().next().value;
    if (oldestRun) {
      runs.delete(oldestRun);
    }
  }
  runs.add(run);
}

export function readTrackedChatSessionRuns(
  host: ChatSessionRunTrackerHost,
  sessionKeys: readonly string[],
): Set<string> {
  const runs = new Set<string>();
  for (const [key, tracked] of host.activeChatRunIdsBySession ?? []) {
    if (matchingSessionKey(key, sessionKeys)) {
      for (const runId of tracked) {
        runs.add(runId);
      }
    }
  }
  return runs;
}

export function settleTrackedChatSessionRun(
  host: ChatSessionRunTrackerHost,
  runId: string | null | undefined,
  sessionKeys: readonly string[],
): void {
  const run = normalized(runId);
  if (!run) {
    return;
  }
  const tracker = host.activeChatRunIdsBySession;
  for (const [key, tracked] of tracker ?? []) {
    if (!matchingSessionKey(key, sessionKeys)) {
      continue;
    }
    tracked.delete(run);
    if (tracked.size === 0) {
      tracker?.delete(key);
    }
  }
}

export function resetTrackedChatSessionRuns(host: ChatSessionRunTrackerHost): void {
  host.activeChatRunIdsBySession?.clear();
}
