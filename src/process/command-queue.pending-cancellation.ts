import { createAbortError } from "../infra/abort-signal.js";
import { getQueueState, type LaneState, type QueueEntry } from "./command-queue.state.js";
import {
  affectedQueueStatesForLanes,
  scheduleQueueStateNotifications,
} from "./command-queue.work-snapshot.js";

type DrainLane = (lane: string) => void;

export type PendingCommandAdmissionHold = {
  readonly workId: string;
  commitCancellation: (reason?: unknown) => number;
  release: () => void;
};

function normalizeWorkId(workId: string): string | undefined {
  return workId.trim() || undefined;
}

/** Check whether an exact higher-layer work id still owns pending queue work. */
export function hasPendingCommandByWorkId(workId: string): boolean {
  const normalizedWorkId = normalizeWorkId(workId);
  if (!normalizedWorkId) {
    return false;
  }
  for (const state of getQueueState().lanes.values()) {
    if (state.queue.some((entry) => entry.workId === normalizedWorkId)) {
      return true;
    }
  }
  return false;
}

/**
 * Keep exact pending work in FIFO position while its higher-level owner makes
 * an asynchronous cancellation decision.
 */
export function acquirePendingCommandAdmissionHoldByWorkIdWithDrain(
  workId: string,
  drainLane: DrainLane,
): PendingCommandAdmissionHold | undefined {
  const normalizedWorkId = normalizeWorkId(workId);
  if (!normalizedWorkId) {
    return undefined;
  }
  const matches: Array<{ state: LaneState; entry: QueueEntry }> = [];
  for (const state of getQueueState().lanes.values()) {
    for (const entry of state.queue) {
      if (entry.workId !== normalizedWorkId) {
        continue;
      }
      if (entry.admissionHold) {
        return undefined;
      }
      matches.push({ state, entry });
    }
  }
  if (matches.length === 0) {
    return undefined;
  }
  const token = Symbol(`command-queue-admission-hold:${normalizedWorkId}`);
  for (const match of matches) {
    match.entry.admissionHold = token;
  }
  let settled = false;
  const resumeTouchedLanes = (touched: ReadonlySet<string>) => {
    for (const lane of touched) {
      const match = matches.find((candidate) => candidate.state.lane === lane);
      if (match && getQueueState().lanes.get(lane) === match.state) {
        drainLane(lane);
      }
    }
  };
  return {
    workId: normalizedWorkId,
    commitCancellation: (reason?: unknown) => {
      if (settled) {
        return 0;
      }
      settled = true;
      const removed: QueueEntry[] = [];
      const changedLanes = new Set<string>();
      for (const match of matches) {
        const index = match.state.queue.findIndex(
          (entry) => entry === match.entry && entry.admissionHold === token,
        );
        if (index < 0) {
          continue;
        }
        const [entry] = match.state.queue.splice(index, 1);
        if (entry) {
          removed.push(entry);
          changedLanes.add(match.state.lane);
        }
      }
      if (removed.length > 0) {
        scheduleQueueStateNotifications(
          new Set(affectedQueueStatesForLanes(changedLanes)),
          removed.flatMap((entry) => (entry.onQueueStateChange ? [entry.onQueueStateChange] : [])),
        );
        const rejection = reason ?? createAbortError("Queued command cancelled");
        for (const entry of removed) {
          entry.reject(rejection);
        }
      }
      resumeTouchedLanes(changedLanes);
      return removed.length;
    },
    release: () => {
      if (settled) {
        return;
      }
      settled = true;
      const changedLanes = new Set<string>();
      for (const match of matches) {
        if (match.entry.admissionHold !== token || !match.state.queue.includes(match.entry)) {
          continue;
        }
        delete match.entry.admissionHold;
        changedLanes.add(match.state.lane);
      }
      resumeTouchedLanes(changedLanes);
    },
  };
}

/** Cancel only pending queue entries owned by one opaque higher-layer work id. */
export function cancelPendingCommandByWorkId(workId: string, reason?: unknown): number {
  const normalizedWorkId = normalizeWorkId(workId);
  if (!normalizedWorkId) {
    return 0;
  }

  const removed: QueueEntry[] = [];
  const changedLanes = new Set<string>();
  for (const state of getQueueState().lanes.values()) {
    for (let index = state.queue.length - 1; index >= 0; index -= 1) {
      if (state.queue[index]?.workId !== normalizedWorkId || state.queue[index]?.admissionHold) {
        continue;
      }
      const [entry] = state.queue.splice(index, 1);
      if (entry) {
        removed.push(entry);
        changedLanes.add(state.lane);
      }
    }
  }

  if (removed.length === 0) {
    return 0;
  }

  scheduleQueueStateNotifications(
    new Set(affectedQueueStatesForLanes(changedLanes)),
    removed.flatMap((entry) => (entry.onQueueStateChange ? [entry.onQueueStateChange] : [])),
  );
  const rejection = reason ?? createAbortError("Queued command cancelled");
  for (const entry of removed) {
    entry.reject(rejection);
  }
  return removed.length;
}
