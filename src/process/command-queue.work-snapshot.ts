import { diagnosticLogger as diag } from "../logging/diagnostic-runtime.js";
import {
  getLaneGroup,
  resolveLaneBlockReason,
  type CommandLaneBlockReason,
} from "./command-queue.capacity-groups.js";
import {
  getQueueState,
  type CommandQueueState,
  type LaneState,
  type QueueEntry,
} from "./command-queue.state.js";
import type { CommandQueueWorkProjection, CommandQueueWorkWait } from "./command-queue.types.js";

const QUEUE_WAIT_WORK_ID_LIMIT = 3;
let workProjectionBuildCount = 0;

export function getCommandQueueWorkProjectionBuildCountForTest(): number {
  return workProjectionBuildCount;
}

function sameWorkIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((workId, index) => workId === right[index]);
}

function sameWorkWait(left: CommandQueueWorkWait, right: CommandQueueWorkWait): boolean {
  return (
    left.lane === right.lane &&
    left.since === right.since &&
    left.queuedAhead === right.queuedAhead &&
    left.busySlots === right.busySlots &&
    left.capacity === right.capacity &&
    left.blockedBy === right.blockedBy &&
    sameWorkIds(left.queuedAheadWorkIds, right.queuedAheadWorkIds) &&
    sameWorkIds(left.activeWorkIds, right.activeWorkIds)
  );
}

export function scheduleQueueStateNotifications(
  states: Iterable<LaneState>,
  extraCallbacks: Iterable<() => void> = [],
): void {
  const queueState = getQueueState();
  queueState.workSnapshotVersion += 1;
  for (const state of states) {
    queueState.pendingQueueStateLanes.add(state.lane);
  }
  for (const callback of extraCallbacks) {
    queueState.pendingQueueStateCallbacks.add(callback);
  }
  if (queueState.queueStateNotificationScheduled) {
    return;
  }
  queueState.queueStateNotificationScheduled = true;
  queueMicrotask(() => {
    const current = getQueueState();
    materializeWorkProjection(current);
    current.queueStateNotificationScheduled = false;
    for (const lane of current.pendingQueueStateLanes) {
      const state = current.lanes.get(lane);
      if (!state) {
        continue;
      }
      for (const entry of state.queue) {
        if (
          entry.onQueueStateChange &&
          (!entry.workId || current.pendingQueueStateChangedWorkIds.has(entry.workId))
        ) {
          current.pendingQueueStateCallbacks.add(entry.onQueueStateChange);
        }
      }
    }
    current.pendingQueueStateLanes.clear();
    current.pendingQueueStateChangedWorkIds.clear();
    const callbacks = [...current.pendingQueueStateCallbacks];
    current.pendingQueueStateCallbacks.clear();
    for (const callback of callbacks) {
      try {
        callback();
      } catch (err) {
        diag.error(`lane queue-state callback failed: error="${String(err)}"`);
      }
    }
  });
}

export function affectedQueueStates(state: LaneState): LaneState[] {
  const group = getLaneGroup(state.lane);
  if (!group) {
    return [state];
  }
  return [...group.members].flatMap((lane) => {
    const member = getQueueState().lanes.get(lane);
    return member ? [member] : [];
  });
}

export function affectedQueueStatesForLanes(lanes: Iterable<string>): LaneState[] {
  return [...lanes].flatMap((lane) => {
    const state = getQueueState().lanes.get(lane);
    return state ? affectedQueueStates(state) : [];
  });
}

export function collectQueueStateCallback(
  callback: (() => void) | undefined,
  callbacks: Array<() => void>,
): void {
  if (callback) {
    callbacks.push(callback);
  }
}

export function scheduleClearedQueueStateNotifications(
  state: LaneState,
  entries: Iterable<QueueEntry>,
): void {
  scheduleQueueStateNotifications(
    affectedQueueStates(state),
    [...entries].flatMap((entry) => (entry.onQueueStateChange ? [entry.onQueueStateChange] : [])),
  );
}

function blockingLaneStates(state: LaneState, blockedBy: CommandLaneBlockReason): LaneState[] {
  if (blockedBy !== "group-budget" && blockedBy !== "sibling-reservation") {
    return [state];
  }
  const group = getLaneGroup(state.lane);
  if (!group) {
    return [state];
  }
  return [...group.members].flatMap((lane) => {
    const member = getQueueState().lanes.get(lane);
    return member ? [member] : [];
  });
}

/**
 * Builds one bounded, process-local snapshot for every identifiable queued
 * work item. Queue core retains only opaque work ids; task/session policy is
 * joined by the Gateway at its public projection boundary.
 */
function buildCommandQueueWorkSnapshot(
  queueState: CommandQueueState,
): Map<string, CommandQueueWorkWait> {
  workProjectionBuildCount += 1;
  const waits = new Map<string, CommandQueueWorkWait>();
  for (const state of queueState.lanes.values()) {
    const blockedBy = resolveLaneBlockReason(state.lane);
    const blockers = blockingLaneStates(state, blockedBy);
    const busySlots = blockers.reduce((total, lane) => total + lane.activeTaskIds.size, 0);
    const group = getLaneGroup(state.lane);
    const siblingReserveHeld =
      group && blockedBy === "sibling-reservation"
        ? [...group.members].reduce((total, member) => {
            if (member === state.lane) {
              return total;
            }
            const active = getQueueState().lanes.get(member)?.activeTaskIds.size ?? 0;
            return total + Math.max(0, (group.reservations.get(member) ?? 0) - active);
          }, 0)
        : 0;
    const capacity =
      group && blockedBy !== "lane"
        ? Math.max(0, group.budget - siblingReserveHeld)
        : state.maxConcurrent;
    const activeWorkIds: string[] = [];
    for (const lane of blockers) {
      for (const workId of lane.activeWorkIds.values()) {
        activeWorkIds.push(workId);
        if (activeWorkIds.length === QUEUE_WAIT_WORK_ID_LIMIT) {
          break;
        }
      }
      if (activeWorkIds.length === QUEUE_WAIT_WORK_ID_LIMIT) {
        break;
      }
    }
    const queuedAheadWorkIds: string[] = [];
    for (const [index, entry] of state.queue.entries()) {
      if (entry.workId) {
        const current = waits.get(entry.workId);
        if (current && current.since > entry.queueWaitStartedAt) {
          continue;
        }
        waits.set(entry.workId, {
          lane: state.lane,
          since: entry.queueWaitStartedAt,
          queuedAhead: index,
          busySlots,
          capacity,
          blockedBy,
          revision: queueState.workSnapshotVersion,
          queuedAheadWorkIds: [...queuedAheadWorkIds],
          activeWorkIds: [...activeWorkIds],
        });
        if (queuedAheadWorkIds.length < QUEUE_WAIT_WORK_ID_LIMIT) {
          queuedAheadWorkIds.push(entry.workId);
        }
      }
    }
  }
  return waits;
}

function refreshWorkProjection(queueState: CommandQueueState): ReadonlySet<string> {
  const previousWaits = queueState.workSnapshotCache ?? new Map<string, CommandQueueWorkWait>();
  const previousRevisions =
    queueState.workProjectionCache?.revisionByWorkId ?? new Map<string, number>();
  const revision = queueState.workSnapshotVersion;
  const candidates = buildCommandQueueWorkSnapshot(queueState);
  const waits = new Map<string, CommandQueueWorkWait>();
  const revisionByWorkId = new Map<string, number>();
  const changedWorkIds = new Set<string>();

  for (const state of queueState.lanes.values()) {
    for (const workId of state.activeWorkIds.values()) {
      const previousRevision = previousRevisions.get(workId);
      const changed = previousRevision === undefined || previousWaits.has(workId);
      revisionByWorkId.set(workId, changed ? revision : previousRevision);
      if (changed) {
        changedWorkIds.add(workId);
      }
    }
  }
  for (const [workId, candidate] of candidates) {
    const previous = previousWaits.get(workId);
    const unchanged = previous !== undefined && sameWorkWait(previous, candidate);
    const workRevision = unchanged
      ? (previousRevisions.get(workId) ?? previous.revision)
      : revision;
    revisionByWorkId.set(workId, workRevision);
    waits.set(workId, unchanged ? previous : { ...candidate, revision: workRevision });
    if (!unchanged) {
      changedWorkIds.add(workId);
    }
  }

  queueState.workSnapshotCache = waits;
  queueState.workSnapshotCacheVersion = queueState.workSnapshotVersion;
  queueState.workProjectionCache = {
    epoch: queueState.workSnapshotEpoch,
    waits,
    revisionByWorkId,
  };
  return changedWorkIds;
}

function materializeWorkProjection(queueState: CommandQueueState): void {
  if (
    queueState.workSnapshotCacheVersion === queueState.workSnapshotVersion &&
    queueState.workSnapshotCache instanceof Map &&
    queueState.workProjectionCache?.epoch === queueState.workSnapshotEpoch &&
    queueState.workProjectionCache.waits === queueState.workSnapshotCache
  ) {
    return;
  }
  const changedWorkIds = refreshWorkProjection(queueState);
  if (queueState.queueStateNotificationScheduled) {
    for (const workId of changedWorkIds) {
      queueState.pendingQueueStateChangedWorkIds.add(workId);
    }
  }
}

export function getCommandQueueWorkSnapshot(): ReadonlyMap<string, CommandQueueWorkWait> {
  const queueState = getQueueState();
  materializeWorkProjection(queueState);
  // SAFETY: materializeWorkProjection populates workSnapshotCache before it returns.
  return queueState.workSnapshotCache as ReadonlyMap<string, CommandQueueWorkWait>;
}

export function getCommandQueueWorkProjection(): CommandQueueWorkProjection {
  const waits = getCommandQueueWorkSnapshot();
  const queueState = getQueueState();
  if (
    queueState.workProjectionCache?.epoch === queueState.workSnapshotEpoch &&
    queueState.workProjectionCache.waits === waits
  ) {
    return queueState.workProjectionCache;
  }
  materializeWorkProjection(queueState);
  // SAFETY: materializeWorkProjection populates workProjectionCache before it returns.
  return queueState.workProjectionCache as CommandQueueWorkProjection;
}
