/**
 * Public enqueue knobs shared by command-lane callers and narrower injection
 * points that should not import the full queue implementation.
 */
export type CommandQueueEnqueueOptions = {
  warnAfterMs?: number;
  onWait?: (waitMs: number, queuedAhead: number) => void;
  /** Opaque owner identity used by higher layers to explain queue waits. */
  workId?: string;
  /** Original wait start when one logical work item crosses multiple lanes. */
  queueWaitStartedAt?: number;
  /** Fires after this queued entry's blockers or position may have changed. */
  onQueueStateChange?: () => void;
  taskTimeoutMs?: number;
  taskTimeoutProgressAtMs?: () => number | undefined;
  taskTimeoutAbortSignal?: AbortSignal;
  taskTimeoutAbortGraceMs?: number;
  /** Ends the task after a caller-owned timeout cleanup grace has already elapsed. */
  taskTimeoutReleaseSignal?: AbortSignal;
  priority?: "foreground" | "normal" | "background";
};

/** Minimal queue function contract used by code that only needs to schedule work. */
export type CommandQueueEnqueueFn = <T>(
  task: () => Promise<T>,
  opts?: CommandQueueEnqueueOptions,
) => Promise<T>;

/** Why a lane cannot admit, from the narrowest cause outward. */
export type CommandLaneBlockReason = "lane" | "group-budget" | "sibling-reservation" | null;

export type CommandLaneGroupState = {
  group: string;
  budget: number;
  members: Set<string>;
  reservations: Map<string, number>;
};

export type CommandQueueWorkWait = {
  lane: string;
  since: number;
  queuedAhead: number;
  busySlots: number;
  capacity: number;
  blockedBy: CommandLaneBlockReason;
  revision: number;
  queuedAheadWorkIds: readonly string[];
  activeWorkIds: readonly string[];
};

export type CommandQueueWorkProjection = {
  epoch: string;
  waits: ReadonlyMap<string, CommandQueueWorkWait>;
  revisionByWorkId: ReadonlyMap<string, number>;
};
