// Public task summaries keep task-registry internals and unbounded status text
// out of gateway responses and events.
import type { TaskSummary } from "../../../packages/gateway-protocol/src/index.js";
import {
  getCommandQueueWorkProjection,
  type CommandQueueWorkProjection,
  type CommandQueueWorkWait,
} from "../../process/command-queue.js";
import { getTaskById } from "../../tasks/runtime-internal.js";
import { getTaskActivitySnapshot } from "../../tasks/task-registry-activity.js";
import { isActiveTaskStatus } from "../../tasks/task-registry-common.js";
import type { TaskRecord, TaskStatus } from "../../tasks/task-registry.types.js";
import {
  TASK_STATUS_DETAIL_MAX_CHARS,
  formatTaskStatusTitle,
  sanitizeTaskPromptText,
  sanitizeTaskStatusText,
} from "../../tasks/task-status.js";

type TaskLedgerStatus = TaskSummary["status"];

const TASK_PROMPT_MAX_CHARS = 4_000;
const TASK_RESULT_MAX_CHARS = 4_000;

const TASK_STATUS_TO_LEDGER_STATUS: Record<TaskStatus, TaskLedgerStatus> = {
  queued: "queued",
  running: "running",
  succeeded: "completed",
  failed: "failed",
  timed_out: "timed_out",
  cancelled: "cancelled",
  lost: "failed",
};

export type TaskEventPayload =
  | { action: "upserted"; task: TaskSummary }
  | { action: "deleted"; taskId: string }
  | { action: "restored" };

type TaskQueueWait = NonNullable<TaskSummary["queueWait"]>;
type QueueWorkSnapshot = ReadonlyMap<string, CommandQueueWorkWait>;

function taskUpdatedAt(task: TaskRecord): number {
  return task.lastEventAt ?? task.endedAt ?? task.startedAt ?? task.createdAt;
}

function sanitizeOptionalTaskText(
  value: unknown,
  opts?: { errorContext?: boolean },
): string | undefined {
  const sanitized = sanitizeTaskStatusText(value, {
    errorContext: opts?.errorContext,
    maxChars: TASK_STATUS_DETAIL_MAX_CHARS,
  });
  return sanitized || undefined;
}

function mapTaskQueueWait(
  task: TaskRecord,
  queueSnapshot: QueueWorkSnapshot,
): TaskQueueWait | undefined {
  const wait = queueSnapshot.get(task.taskId);
  if (!wait) {
    return undefined;
  }
  const seenTaskIds = new Set<string>();
  const mapBlockers = (workIds: readonly string[]) => {
    const blockers: TaskQueueWait["activeBlockers"] = [];
    for (const workId of workIds) {
      const blocker = getTaskById(workId);
      if (
        !blocker ||
        !isActiveTaskStatus(blocker.status) ||
        blocker.taskId === task.taskId ||
        seenTaskIds.has(blocker.taskId)
      ) {
        continue;
      }
      seenTaskIds.add(blocker.taskId);
      blockers.push({
        taskId: blocker.taskId,
        title: formatTaskStatusTitle(blocker),
        ...(blocker.childSessionKey || blocker.requesterSessionKey
          ? { sessionKey: blocker.childSessionKey ?? blocker.requesterSessionKey }
          : {}),
      });
    }
    return blockers;
  };
  return {
    since: wait.since,
    queuedAhead: wait.queuedAhead,
    busySlots: wait.busySlots,
    capacity: wait.capacity,
    activeBlockers: mapBlockers(wait.activeWorkIds),
    aheadBlockers: mapBlockers(wait.queuedAheadWorkIds),
  };
}

export function projectTaskLedgerStatus(
  task: TaskRecord,
  queueProjection: CommandQueueWorkProjection,
): TaskLedgerStatus {
  return isActiveTaskStatus(task.status) && queueProjection.waits.has(task.taskId)
    ? "queued"
    : TASK_STATUS_TO_LEDGER_STATUS[task.status];
}

export function mapTaskSummary(
  task: TaskRecord,
  opts?: { includePrompt?: boolean; queueProjection?: CommandQueueWorkProjection },
): TaskSummary {
  const activity = getTaskActivitySnapshot(task.taskId);
  const lastActivity = sanitizeOptionalTaskText(activity?.lastActivity);
  const progressSummary = sanitizeOptionalTaskText(task.progressSummary);
  const terminalSummary = sanitizeOptionalTaskText(task.terminalSummary, { errorContext: true });
  const error = sanitizeOptionalTaskText(task.error, { errorContext: true });
  const lastToolName = sanitizeOptionalTaskText(task.lastToolName);
  const prompt = opts?.includePrompt
    ? sanitizeTaskPromptText(task.task, TASK_PROMPT_MAX_CHARS) || undefined
    : undefined;
  const result = opts?.includePrompt
    ? sanitizeTaskStatusText(task.progressSummary, { maxChars: TASK_RESULT_MAX_CHARS }) || undefined
    : undefined;
  const toolUseCount =
    typeof task.toolUseCount === "number" && Number.isInteger(task.toolUseCount)
      ? Math.max(0, task.toolUseCount)
      : undefined;
  const active = isActiveTaskStatus(task.status);
  const workProjection = opts?.queueProjection ?? getCommandQueueWorkProjection();
  const queueWait = active ? mapTaskQueueWait(task, workProjection.waits) : undefined;
  const queueRevision = active ? workProjection.revisionByWorkId.get(task.taskId) : undefined;
  return {
    id: task.taskId,
    taskId: task.taskId,
    kind: task.taskKind ?? task.runtime,
    runtime: task.runtime,
    status: projectTaskLedgerStatus(task, workProjection),
    title: formatTaskStatusTitle(task),
    ...(task.agentId ? { agentId: task.agentId } : {}),
    sessionKey: task.requesterSessionKey,
    ...(task.childSessionKey ? { childSessionKey: task.childSessionKey } : {}),
    ownerKey: task.ownerKey,
    ...(task.runId ? { runId: task.runId } : {}),
    ...(task.parentFlowId ? { flowId: task.parentFlowId } : {}),
    ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
    ...(task.sourceId ? { sourceId: task.sourceId } : {}),
    createdAt: task.createdAt,
    updatedAt: taskUpdatedAt(task),
    ...(task.startedAt !== undefined ? { startedAt: task.startedAt } : {}),
    ...(task.endedAt !== undefined ? { endedAt: task.endedAt } : {}),
    ...(toolUseCount !== undefined ? { toolUseCount } : {}),
    ...(lastToolName ? { lastToolName } : {}),
    ...(lastActivity ? { lastActivity } : {}),
    ...(activity?.diffStat ? { diffStat: activity.diffStat } : {}),
    ...(queueRevision !== undefined ? { queueEpoch: workProjection.epoch } : {}),
    ...(queueRevision !== undefined ? { queueRevision } : {}),
    ...(queueWait ? { queueWait } : {}),
    ...(progressSummary ? { progressSummary } : {}),
    ...(terminalSummary ? { terminalSummary } : {}),
    ...(error ? { error } : {}),
    deliveryStatus: task.deliveryStatus,
    ...(task.terminalOutcome ? { terminalOutcome: task.terminalOutcome } : {}),
    ...(result ? { result } : {}),
    ...(prompt ? { prompt } : {}),
  };
}
