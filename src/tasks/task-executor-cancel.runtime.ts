// Lazy runtime boundary for task cancellation and its runtime-specific control stack.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { getRegisteredDetachedTaskLifecycleRuntime } from "./detached-task-runtime-state.js";
import {
  assertTaskCancellationReadyById,
  cancelTaskById,
  getTaskById,
} from "./runtime-internal.js";
import type { TaskCancellationCommitBarrier } from "./task-registry-cancel.js";

export async function cancelDetachedTaskRunByIdCore(params: {
  cfg: OpenClawConfig;
  taskId: string;
  reason?: string;
  beforeTaskCancellationCommit?: TaskCancellationCommitBarrier;
  afterRegisteredRuntimeCancellationAccepted?: () => void;
}) {
  const task = getTaskById(params.taskId);
  const registeredRuntime = getRegisteredDetachedTaskLifecycleRuntime();
  if (task) {
    try {
      assertTaskCancellationReadyById(task.taskId);
    } catch (error) {
      return {
        found: true,
        cancelled: false,
        reason: formatErrorMessage(error),
        task,
      };
    }
  }
  if (registeredRuntime) {
    const cancelled = await registeredRuntime.cancelDetachedTaskRunById({
      cfg: params.cfg,
      taskId: params.taskId,
      ...(params.reason ? { reason: params.reason } : {}),
    });
    if (cancelled.found) {
      if (cancelled.cancelled) {
        params.afterRegisteredRuntimeCancellationAccepted?.();
      }
      return cancelled;
    }
  }
  return cancelTaskById(params);
}
