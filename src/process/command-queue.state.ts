// Shared command-queue runtime state, split out of command-queue.ts so the
// capacity-group policy can read lane state without importing the queue itself.
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type {
  CommandLaneGroupState,
  CommandQueueWorkProjection,
  CommandQueueWorkWait,
} from "./command-queue.types.js";
import { CommandLane } from "./lanes.js";

export type CommandLaneTaskMarker = Readonly<{
  lane: string;
  taskId: number;
  generation: number;
}>;

export type QueueEntry = {
  task: (marker: CommandLaneTaskMarker) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  enqueuedAt: number;
  sequence: number;
  priority: number;
  warnAfterMs: number;
  queuedAheadAtEnqueue: number;
  activeAheadAtEnqueue: number;
  workId?: string;
  queueWaitStartedAt: number;
  admissionHold?: symbol;
  onQueueStateChange?: () => void;
  taskTimeoutMs?: number;
  taskTimeoutProgressAtMs?: () => number | undefined;
  taskTimeoutAbortSignal?: AbortSignal;
  taskTimeoutAbortGraceMs?: number;
  taskTimeoutReleaseSignal?: AbortSignal;
  onWait?: (waitMs: number, queuedAhead: number) => void;
};

export type LaneState = {
  lane: string;
  queue: QueueEntry[];
  activeTaskIds: Set<number>;
  activeWorkIds: Map<number, string>;
  maxConcurrent: number;
  draining: boolean;
  generation: number;
};

export type ActiveTaskWaiter = {
  activeTaskIds: Set<number>;
  resolve: (value: { drained: boolean }) => void;
  timeout?: ReturnType<typeof setTimeout>;
};

export type CommandQueueState = {
  lanes: Map<string, LaneState>;
  activeTaskWaiters: Set<ActiveTaskWaiter>;
  nextTaskId: number;
  nextQueueSequence: number;
  workSnapshotEpoch: string;
  workSnapshotVersion: number;
  workSnapshotCacheVersion: number;
  workSnapshotCache?: ReadonlyMap<string, CommandQueueWorkWait>;
  workProjectionCache?: CommandQueueWorkProjection;
  pendingQueueStateCallbacks: Set<() => void>;
  pendingQueueStateChangedWorkIds: Set<string>;
  pendingQueueStateLanes: Set<string>;
  queueStateNotificationScheduled: boolean;
  laneGroups: Map<string, CommandLaneGroupState>;
  laneGroupByLane: Map<string, string>;
};

/**
 * Keep queue runtime state on globalThis so every bundled entry/chunk shares
 * the same lanes, counters, and draining flag in production builds.
 */
const COMMAND_QUEUE_STATE_KEY = Symbol.for("openclaw.commandQueueState");

export function getQueueState(): CommandQueueState {
  const state = resolveGlobalSingleton<CommandQueueState>(COMMAND_QUEUE_STATE_KEY, () => ({
    lanes: new Map<string, LaneState>(),
    activeTaskWaiters: new Set<ActiveTaskWaiter>(),
    nextTaskId: 1,
    nextQueueSequence: 1,
    workSnapshotEpoch: crypto.randomUUID(),
    workSnapshotVersion: 0,
    workSnapshotCacheVersion: -1,
    workSnapshotCache: undefined,
    workProjectionCache: undefined,
    pendingQueueStateCallbacks: new Set<() => void>(),
    pendingQueueStateChangedWorkIds: new Set<string>(),
    pendingQueueStateLanes: new Set<string>(),
    queueStateNotificationScheduled: false,
    laneGroups: new Map<string, CommandLaneGroupState>(),
    laneGroupByLane: new Map<string, string>(),
  }));
  // Schema migration: the singleton may have been created by an older code
  // version (e.g. v2026.4.2) that did not include `activeTaskWaiters`.  After
  // a SIGUSR1 in-process restart the new code inherits the stale object via
  // `resolveGlobalSingleton` because the Symbol key already exists on
  // globalThis.  Patch the missing field so all downstream consumers see a
  // valid Set instead of `undefined`.
  if (!state.activeTaskWaiters) {
    state.activeTaskWaiters = new Set<ActiveTaskWaiter>();
  }
  if (!state.nextQueueSequence) {
    state.nextQueueSequence = 1;
  }
  if (!state.workSnapshotEpoch) {
    state.workSnapshotEpoch = crypto.randomUUID();
  }
  if (!Number.isFinite(state.workSnapshotVersion)) {
    state.workSnapshotVersion = 0;
  }
  if (!Number.isFinite(state.workSnapshotCacheVersion)) {
    state.workSnapshotCacheVersion = -1;
  }
  if (!state.pendingQueueStateCallbacks) {
    state.pendingQueueStateCallbacks = new Set<() => void>();
  }
  if (!state.pendingQueueStateChangedWorkIds) {
    state.pendingQueueStateChangedWorkIds = new Set<string>();
  }
  if (!state.pendingQueueStateLanes) {
    state.pendingQueueStateLanes = new Set<string>();
  }
  if (typeof state.queueStateNotificationScheduled !== "boolean") {
    state.queueStateNotificationScheduled = false;
  }
  if (!state.laneGroups) {
    state.laneGroups = new Map<string, CommandLaneGroupState>();
  }
  if (!state.laneGroupByLane) {
    state.laneGroupByLane = new Map<string, string>();
  }
  let maxQueueSequence = state.nextQueueSequence - 1;
  for (const lane of state.lanes.values()) {
    if (!lane.activeWorkIds) {
      lane.activeWorkIds = new Map<number, string>();
    }
    for (const [index, entry] of (
      lane.queue as Array<
        QueueEntry & {
          activeAheadAtEnqueue?: number;
          priority?: number;
          queuedAheadAtEnqueue?: number;
          queueWaitStartedAt?: number;
          sequence?: number;
        }
      >
    ).entries()) {
      if (typeof entry.priority !== "number") {
        entry.priority = 0;
      }
      if (typeof entry.sequence !== "number") {
        entry.sequence = state.nextQueueSequence++;
      } else {
        maxQueueSequence = Math.max(maxQueueSequence, entry.sequence);
      }
      if (typeof entry.queuedAheadAtEnqueue !== "number") {
        entry.queuedAheadAtEnqueue = index;
      }
      if (typeof entry.activeAheadAtEnqueue !== "number") {
        entry.activeAheadAtEnqueue = lane.activeTaskIds.size;
      }
      if (typeof entry.queueWaitStartedAt !== "number") {
        entry.queueWaitStartedAt = entry.enqueuedAt;
      }
    }
  }
  if (state.nextQueueSequence <= maxQueueSequence) {
    state.nextQueueSequence = maxQueueSequence + 1;
  }
  return state;
}

export function normalizeLane(lane: string): string {
  return lane.trim() || CommandLane.Main;
}
