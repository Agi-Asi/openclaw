/**
 * Memory isolation narrows autonomous work before any session transcript is
 * selected. A service/child run may gain an explicit plugin capability later,
 * but it must never inherit raw user history as a substitute for one.
 */
export function resolveSubagentMemoryContextMode(params: {
  requested: "fork" | "isolated";
  memoryIsolationActive: boolean;
}): "fork" | "isolated" {
  return params.memoryIsolationActive && params.requested === "fork" ? "isolated" : params.requested;
}

/** Current-bound cron work is autonomous under memory isolation, not a replay of its old target. */
export function mayInjectAutonomousSourceTranscript(params: {
  sessionTarget?: string;
  memoryIsolationActive: boolean;
}): boolean {
  return !(params.memoryIsolationActive && params.sessionTarget === "current");
}
