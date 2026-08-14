// Task gateway methods expose detached task list/get/cancel operations with
// bounded public summaries over the runtime task registry.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type TaskSummary,
  type TasksListParams,
  validateTasksCancelParams,
  validateTasksGetParams,
  validateTasksListParams,
  validateTasksRecoveryParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  dismissSubagentCompletionDelivery,
  retrySubagentCompletionDelivery,
} from "../../agents/subagents/completion/subagent-completion-delivery.js";
import { canonicalizeMainSessionAlias } from "../../config/sessions.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  acquirePendingCommandAdmissionHoldByWorkId,
  cancelPendingCommandByWorkId,
  getCommandQueueWorkProjection,
  type PendingCommandAdmissionHold,
} from "../../process/command-queue.js";
import { hasPendingCommandByWorkId } from "../../process/command-queue.pending-cancellation.js";
import { isBackgroundExecTask } from "../../tasks/background-exec-task-contract.js";
import { getRegisteredDetachedTaskLifecycleRuntime } from "../../tasks/detached-task-runtime-state.js";
import { getTaskById, listTaskRecordPage } from "../../tasks/runtime-internal.js";
import { isActiveTaskStatus } from "../../tasks/task-registry-common.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import { abortChatRunById, type ChatAbortControllerEntry } from "../chat-abort.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { createChatAbortOps } from "./chat-abort-runtime.js";
import { mapTaskSummary, projectTaskLedgerStatus } from "./task-summary.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const DEFAULT_TASKS_LIST_LIMIT = 100;
const MAX_TASKS_LIST_LIMIT = 500;
const CLI_TASK_CANCELLATION_OWNERSHIP_ERROR =
  "Task does not own the active Gateway cancellation handle.";
const CLI_TASK_CANCELLATION_HANDLE_MISSING_ERROR =
  "CLI task has no pending queue entry or active Gateway cancellation handle.";
const CLI_TASK_CANCELLATION_REFUSED_ERROR =
  "CLI task's active Gateway cancellation handle refused cancellation.";
const CUSTOM_TASK_GATEWAY_COORDINATION_ERROR =
  "Task runtime cannot coordinate Gateway queue cancellation.";

type TaskLedgerStatus = TaskSummary["status"];

function normalizeTaskStatusFilter(
  status: TasksListParams["status"],
): Set<TaskLedgerStatus> | null {
  if (!status) {
    return null;
  }
  const statuses = Array.isArray(status) ? status : [status];
  return new Set(statuses);
}

// Cursor strings are offsets, not opaque tokens; reject malformed values so a
// client cannot silently restart pagination at the first page.
function parseCursor(cursor: string | undefined): number | null {
  if (!cursor) {
    return 0;
  }
  if (!/^\d+$/.test(cursor.trim())) {
    return null;
  }
  const parsed = Number(cursor);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

type GatewayTaskStopResult = { stopped: true } | { stopped: false; reason: string };

type ControllerBoundDetachedTaskLookup =
  | { state: "none" }
  | { state: "unresolved" }
  | { state: "resolved"; task: TaskRecord };

function findControllerBoundDetachedTask(
  context: GatewayRequestContext,
  taskId: string,
): ControllerBoundDetachedTaskLookup {
  let owner: { runId: string; entry: ChatAbortControllerEntry } | undefined;
  for (const [runId, entry] of context.chatAbortControllers) {
    if (entry.kind !== "agent" || entry.taskId !== taskId) {
      continue;
    }
    if (owner) {
      return { state: "unresolved" };
    }
    owner = { runId, entry };
  }
  if (!owner) {
    return { state: "none" };
  }
  const sessionKey = owner.entry.sessionKey.trim();
  const task = owner.entry.detachedTask;
  if (!owner.runId.trim() || !sessionKey || !task) {
    return { state: "unresolved" };
  }
  const controller = owner.entry.controller;
  const current = context.chatAbortControllers.get(owner.runId);
  if (
    current?.controller !== controller ||
    current.taskId !== taskId ||
    current.detachedTask !== task ||
    task.taskId !== taskId ||
    task.runId !== owner.runId ||
    task.childSessionKey !== sessionKey
  ) {
    return { state: "unresolved" };
  }
  return { state: "resolved", task };
}

function getGatewayTaskController(
  context: GatewayRequestContext,
  task: TaskRecord,
): ChatAbortControllerEntry | undefined {
  const runId = task.runId?.trim();
  const sessionKey = task.childSessionKey?.trim();
  if (!runId || !sessionKey) {
    return undefined;
  }
  const active = context.chatAbortControllers.get(runId);
  return active?.kind === "agent" &&
    active.taskId === task.taskId &&
    active.sessionKey === sessionKey
    ? active
    : undefined;
}

type GatewayTaskStopClaim = {
  task: TaskRecord;
  pending: boolean;
  controller?: ChatAbortControllerEntry;
};

function claimGatewayTaskStopOwner(
  context: GatewayRequestContext,
  task: TaskRecord,
): GatewayTaskStopClaim | undefined {
  const pending = hasPendingCommandByWorkId(task.taskId);
  const controller = getGatewayTaskController(context, task);
  return pending || controller ? { task, pending, controller } : undefined;
}

function isGatewayTaskStopClaimPresent(
  context: GatewayRequestContext,
  claim: GatewayTaskStopClaim,
): boolean {
  if (claim.pending && hasPendingCommandByWorkId(claim.task.taskId)) {
    return true;
  }
  const runId = claim.task.runId?.trim();
  return Boolean(
    runId && claim.controller && context.chatAbortControllers.get(runId) === claim.controller,
  );
}

function abortClaimedGatewayTaskController(
  context: GatewayRequestContext,
  claim: GatewayTaskStopClaim,
) {
  const runId = claim.task.runId?.trim();
  const sessionKey = claim.task.childSessionKey?.trim();
  const active = runId ? context.chatAbortControllers.get(runId) : undefined;
  const ownsActiveController = Boolean(claim.controller && active === claim.controller);
  const abortResult =
    runId && sessionKey && ownsActiveController
      ? abortChatRunById(createChatAbortOps(context), {
          runId,
          sessionKey,
          stopReason: "rpc",
        })
      : undefined;
  return { runId, sessionKey, active, ownsActiveController, abortResult };
}

function stopGatewayTask(
  context: GatewayRequestContext,
  claim: GatewayTaskStopClaim,
  pendingHold: PendingCommandAdmissionHold | undefined,
): GatewayTaskStopResult {
  const heldRemoved = pendingHold?.commitCancellation() ?? 0;
  const { runId, sessionKey, active, ownsActiveController, abortResult } =
    abortClaimedGatewayTaskController(context, claim);
  // A held entry cannot dispatch, so remove it before controller lifecycle
  // listeners run. Unheld legacy paths still abort first so their pending
  // promise reaches dispatch with an aborted signal during terminalization.
  const removed = pendingHold ? heldRemoved : cancelPendingCommandByWorkId(claim.task.taskId);
  if (removed > 0) {
    return { stopped: true };
  }
  if (!runId || !sessionKey || !active) {
    return { stopped: false, reason: CLI_TASK_CANCELLATION_HANDLE_MISSING_ERROR };
  }
  if (!ownsActiveController) {
    return {
      stopped: false,
      reason: CLI_TASK_CANCELLATION_OWNERSHIP_ERROR,
    };
  }
  return abortResult?.aborted
    ? { stopped: true }
    : { stopped: false, reason: CLI_TASK_CANCELLATION_REFUSED_ERROR };
}

// Control UI task methods expose the stable gateway protocol shape; helpers
// above keep runtime registry details out of the wire result.
export const tasksHandlers: GatewayRequestHandlers = {
  "tasks.list": ({ params, respond, context }) => {
    if (!assertValidParams(params, validateTasksListParams, "tasks.list", respond)) {
      return;
    }
    const cursor = parseCursor(params.cursor);
    if (cursor === null) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid tasks.list cursor"),
      );
      return;
    }
    const statusFilter = normalizeTaskStatusFilter(params.status);
    const limit = Math.min(params.limit ?? DEFAULT_TASKS_LIST_LIMIT, MAX_TASKS_LIST_LIMIT);
    const requestedSessionKey = normalizeOptionalString(params.sessionKey);
    const cfg = context.getRuntimeConfig();
    let sessionKey: string | undefined;
    let sessionAgentId: string | undefined;
    if (requestedSessionKey) {
      const sessionOwner = resolveRequestedSessionAgentId(
        cfg,
        requestedSessionKey,
        normalizeOptionalString(params.agentId),
      );
      if (!sessionOwner.ok) {
        respond(false, undefined, sessionOwner.error);
        return;
      }
      sessionAgentId = sessionOwner.agentId;
      sessionKey = canonicalizeMainSessionAlias({
        cfg,
        agentId: sessionOwner.agentId,
        sessionKey: requestedSessionKey,
      });
    }
    // The ledger pages by last activity so an old long-running task that just
    // finished still surfaces first. Selection stays inside the registry so
    // only the bounded wire page pays for defensive record cloning.
    const queueProjection = getCommandQueueWorkProjection();
    const page = listTaskRecordPage({
      offset: cursor,
      limit,
      includeTask: statusFilter
        ? (task) => statusFilter.has(projectTaskLedgerStatus(task, queueProjection))
        : undefined,
      agentId: sessionKey ? undefined : params.agentId,
      sessionKey,
      sessionAgentId,
      cfg,
    });
    const nextOffset = cursor + page.tasks.length;
    respond(true, {
      tasks: page.tasks.map((task) => mapTaskSummary(task, { queueProjection })),
      ...(page.hasMore ? { nextCursor: String(nextOffset) } : {}),
    });
  },
  "tasks.get": ({ params, respond }) => {
    if (!assertValidParams(params, validateTasksGetParams, "tasks.get", respond)) {
      return;
    }
    const taskId = params.taskId;
    const task = getTaskById(taskId);
    if (!task) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `task not found: ${taskId}`),
      );
      return;
    }
    // The potentially longer task input is lookup-only. List and event payloads
    // stay compact while detail views can show the operator what was requested.
    respond(true, { task: mapTaskSummary(task, { includePrompt: true }) });
  },
  "tasks.cancel": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateTasksCancelParams, "tasks.cancel", respond)) {
      return;
    }
    const taskId = params.taskId;
    const reason = normalizeOptionalString(params.reason);
    const { cancelDetachedTaskRunByIdCore } =
      await import("../../tasks/task-executor-cancel.runtime.js");
    const existingTask = getTaskById(taskId);
    const controllerBoundDetachedTask = existingTask
      ? { state: "none" as const }
      : findControllerBoundDetachedTask(context, taskId);
    if (controllerBoundDetachedTask.state === "unresolved") {
      respond(true, {
        found: true,
        cancelled: false,
        reason: CUSTOM_TASK_GATEWAY_COORDINATION_ERROR,
      });
      return;
    }
    const resolvedTask =
      existingTask ??
      (controllerBoundDetachedTask.state === "resolved"
        ? controllerBoundDetachedTask.task
        : undefined);
    const activeTask =
      resolvedTask && isActiveTaskStatus(resolvedTask.status) ? resolvedTask : undefined;
    const isGatewayAgentCliTask =
      activeTask?.runtime === "cli" && !isBackgroundExecTask(activeTask);
    const gatewayStopClaim =
      activeTask && !isBackgroundExecTask(activeTask)
        ? claimGatewayTaskStopOwner(context, activeTask)
        : undefined;
    if (isGatewayAgentCliTask && !gatewayStopClaim) {
      const activeController = activeTask.runId?.trim()
        ? context.chatAbortControllers.get(activeTask.runId.trim())
        : undefined;
      respond(true, {
        found: true,
        cancelled: false,
        reason: activeController
          ? CLI_TASK_CANCELLATION_OWNERSHIP_ERROR
          : CLI_TASK_CANCELLATION_HANDLE_MISSING_ERROR,
        task: mapTaskSummary(activeTask),
      });
      return;
    }
    const registeredRuntime = getRegisteredDetachedTaskLifecycleRuntime();
    const pendingHold =
      gatewayStopClaim?.pending && registeredRuntime
        ? acquirePendingCommandAdmissionHoldByWorkId(taskId)
        : undefined;
    if (gatewayStopClaim?.pending && registeredRuntime && !pendingHold) {
      respond(true, {
        found: true,
        cancelled: false,
        reason: CUSTOM_TASK_GATEWAY_COORDINATION_ERROR,
        ...(activeTask ? { task: mapTaskSummary(activeTask) } : {}),
      });
      return;
    }
    let result: Awaited<ReturnType<typeof cancelDetachedTaskRunByIdCore>>;
    try {
      result = await cancelDetachedTaskRunByIdCore({
        cfg: context.getRuntimeConfig(),
        taskId,
        ...(reason ? { reason } : {}),
        ...(gatewayStopClaim
          ? {
              afterRegisteredRuntimeCancellationAccepted: () => {
                pendingHold?.commitCancellation();
                abortClaimedGatewayTaskController(context, gatewayStopClaim);
              },
              beforeTaskCancellationCommit: () => {
                const stopped = stopGatewayTask(context, gatewayStopClaim, pendingHold);
                if (stopped.stopped) {
                  return { ok: true as const };
                }
                if (
                  gatewayStopClaim.task.runtime !== "cli" &&
                  !isGatewayTaskStopClaimPresent(context, gatewayStopClaim)
                ) {
                  return { ok: true as const };
                }
                return { ok: false as const, reason: stopped.reason };
              },
            }
          : {}),
      });
    } catch (error) {
      if (!gatewayStopClaim) {
        throw error;
      }
      result = {
        found: true,
        cancelled: false,
        reason: formatErrorMessage(error),
        task: activeTask,
      };
    } finally {
      pendingHold?.release();
    }
    respond(true, {
      found: result.found,
      cancelled: result.cancelled,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.task ? { task: mapTaskSummary(result.task) } : {}),
    });
  },
  "tasks.retry": async ({ params, respond }) => {
    if (!assertValidParams(params, validateTasksRecoveryParams, "tasks.retry", respond)) {
      return;
    }
    const results = [];
    for (const taskId of params.taskIds) {
      const result = await retrySubagentCompletionDelivery(taskId);
      results.push({
        taskId,
        ok: result.ok,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.duplicateRisk ? { duplicateRisk: true } : {}),
        ...(result.task ? { task: mapTaskSummary(result.task, { includePrompt: true }) } : {}),
      });
    }
    respond(true, { results });
  },
  "tasks.dismiss": async ({ params, respond }) => {
    if (!assertValidParams(params, validateTasksRecoveryParams, "tasks.dismiss", respond)) {
      return;
    }
    const { discardSubagentTerminalDelivery } =
      await import("../../agents/subagents/registry/subagent-registry.js");
    const results = [];
    for (const taskId of params.taskIds) {
      const result = await dismissSubagentCompletionDelivery(taskId, {
        discardTerminalDelivery: discardSubagentTerminalDelivery,
      });
      results.push({
        taskId,
        ok: result.ok,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.task ? { task: mapTaskSummary(result.task, { includePrompt: true }) } : {}),
      });
    }
    respond(true, { results });
  },
};
