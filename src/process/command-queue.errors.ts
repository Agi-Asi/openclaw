/** Error thrown when a queued command is rejected because its lane was cleared. */
export class CommandLaneClearedError extends Error {
  constructor(lane?: string) {
    super(lane ? `Command lane "${lane}" cleared` : "Command lane cleared");
    this.name = "CommandLaneClearedError";
  }
}

type CommandLaneTaskTimeoutDetails =
  | { cause: "task-budget"; elapsedMs: number; taskBudgetMs: number }
  | { cause: "progress-idle"; elapsedMs: number; idleMs: number; taskBudgetMs: number }
  | { cause: "abort-grace"; elapsedMs: number; graceMs: number; taskBudgetMs: number }
  | { cause: "release-signal"; elapsedMs: number; taskBudgetMs: number };

/** Error thrown when active work exceeds its caller-owned lane timeout. */
export class CommandLaneTaskTimeoutError extends Error {
  constructor(lane: string, details: CommandLaneTaskTimeoutDetails) {
    const message = (() => {
      switch (details.cause) {
        case "task-budget":
          return `elapsed ${details.elapsedMs}ms reached task budget ${details.taskBudgetMs}ms`;
        case "progress-idle":
          return `no progress for ${details.idleMs}ms (task budget ${details.taskBudgetMs}ms, elapsed ${details.elapsedMs}ms)`;
        case "abort-grace":
          return `abort grace ${details.graceMs}ms elapsed (task budget ${details.taskBudgetMs}ms, elapsed ${details.elapsedMs}ms)`;
        case "release-signal":
          return `lane release requested after ${details.elapsedMs}ms (task budget ${details.taskBudgetMs}ms)`;
        default:
          throw new TypeError("Unsupported command lane timeout cause");
      }
    })();
    super(`Command lane "${lane}" task timed out: ${message}`);
    this.name = "CommandLaneTaskTimeoutError";
  }
}

export function isCommandLaneTaskTimeoutError(err: unknown, lane?: string): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  if (!(err instanceof CommandLaneTaskTimeoutError || err.name === "CommandLaneTaskTimeoutError")) {
    return false;
  }
  return lane === undefined || err.message.includes(`Command lane "${lane}" task timed out`);
}
