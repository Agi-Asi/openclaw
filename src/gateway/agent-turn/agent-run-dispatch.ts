import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  buildAgentRunTerminalOutcome,
  classifyAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../../agents/agent-run-terminal-outcome.js";
import {
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../../agents/cron-creator-authority-context.js";
import { isTimeoutError } from "../../agents/failover-error.js";
import type { MainSessionRecoveryPendingTarget } from "../../agents/main-session-recovery/main-session-recovery-store.js";
import { isAgentRunRestartAbortReason } from "../../agents/run-termination.js";
import { normalizeAgentRunTimeoutPhase } from "../../agents/run-timeout-attribution.js";
import { readAgentRunTerminalOutcome } from "../../channels/turn/agent-run-terminal-outcome.js";
import { agentCommandFromGatewayIngress } from "../../commands/agent.js";
import { isAbortError } from "../../infra/abort-signal.js";
import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import { formatErrorMessageWithCode, readErrorName } from "../../infra/errors.js";
import { defaultRuntime } from "../../runtime.js";
import {
  createQueuedTaskRun,
  findDetachedTaskRunAcrossRuntimes,
  startTaskRunByRunId,
} from "../../tasks/detached-task-runtime.js";
import {
  getTaskById,
  markTaskRunningById,
  publishTaskProjectionById,
  resolveActiveTaskByRunScope,
} from "../../tasks/runtime-internal.js";
import {
  isActiveTaskStatus,
  mapAgentRunTerminalOutcomeToTaskStatus,
} from "../../tasks/task-registry-common.js";
import type { TaskRecord, TaskRuntime } from "../../tasks/task-registry.types.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.shared.js";
import type { ChatAbortControllerEntry } from "../chat-abort.js";
import {
  tryFinalizeTrackedAgentTask,
  type GatewayAgentTaskTrackingMode,
} from "../server-methods/agent-task-tracking.js";
import type { GatewayCronCreatorAuthorityAdmission } from "../server-methods/cron-creator-authority-admission.js";
import { emitSessionsChanged } from "../server-methods/session-change-event.js";
import { formatForLog } from "../ws-log.js";
import { setGatewayDedupeEntries } from "./agent-dedupe.js";
import type { AgentTurnContext, AgentTurnIo } from "./types.js";

function resolveResolvedAgentTimeoutStopReason(
  meta: unknown,
  signal: AbortSignal,
): "timeout" | undefined {
  if (!signal.aborted) {
    return undefined;
  }
  const record =
    meta && typeof meta === "object" && !Array.isArray(meta)
      ? (meta as Record<string, unknown>)
      : undefined;
  if (record?.aborted !== true && record?.stopReason !== "toolUse") {
    return undefined;
  }
  return resolveGatewayAgentAbortStopReason(signal) === "timeout" ? "timeout" : undefined;
}

function isGatewayAbortSignalReason(reason: unknown): boolean {
  return reason === undefined || isAbortError(reason) || readErrorName(reason) === "TimeoutError";
}

function isGatewayAgentAbortRejection(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) {
    return false;
  }
  if (isAgentRunRestartAbortReason(signal.reason)) {
    return true;
  }
  if (readErrorName(signal.reason) === "TimeoutError") {
    return true;
  }
  if (!isGatewayAbortSignalReason(signal.reason)) {
    return false;
  }
  return isAbortError(error) || readErrorName(error) === "TimeoutError";
}

function resolveGatewayAgentAbortStopReason(signal: AbortSignal): "restart" | "rpc" | "timeout" {
  if (isAgentRunRestartAbortReason(signal.reason)) {
    return "restart";
  }
  return readErrorName(signal.reason) === "TimeoutError" ? "timeout" : "rpc";
}

// `agent` clients already consume cancellation as timeout; keep that wire
// contract while task/session projections use the canonical cancellation class.
const RESOLVED_GATEWAY_STATUS_BY_TERMINAL_CLASSIFICATION = {
  success: "ok",
  timeout: "timeout",
  cancellation: "timeout",
  failure: "error",
} as const;

function projectRejectedGatewayStatus(outcome: AgentRunTerminalOutcome): "error" | "timeout" {
  // The shipped wire keeps raw provider/AbortError rejections as errors. Only
  // signal-owned cancellation/timeout metadata promotes a rejection to timeout.
  return outcome.reason === "cancelled" ||
    outcome.reason === "superseded" ||
    outcome.stopReason === "timeout"
    ? "timeout"
    : "error";
}

export function resolveAbortedAgentStopReason(entry?: ChatAbortControllerEntry): string {
  return entry?.abortStopReason?.trim() || "rpc";
}

export function deleteGatewayDedupeEntries(params: {
  dedupe: AgentTurnContext["dedupe"];
  keys: readonly string[];
}) {
  for (const key of params.keys) {
    params.dedupe.delete(key);
  }
}

export function dispatchAgentRunFromGateway(params: {
  ingressOpts: Parameters<typeof agentCommandFromGatewayIngress>[0];
  runId: string;
  cronCreatorAuthority?: GatewayCronCreatorAuthorityAdmission;
  dedupeKeys: readonly string[];
  /**
   * Controller whose signal is wired into `ingressOpts.abortSignal`. Used on
   * completion to drop the matching `chatAbortControllers` entry without
   * touching a same-runId entry owned by a concurrent chat.send.
   */
  abortController: AbortController;
  cleanupAbortController: () => void;
  io: AgentTurnIo;
  context: AgentTurnContext;
  taskTrackingMode: Exclude<GatewayAgentTaskTrackingMode, "plugin_subagent">;
  restoreAdmittedRecovery?: () => Promise<MainSessionRecoveryPendingTarget | undefined>;
  onSettled?: (outcome: {
    terminalOutcome: AgentRunTerminalOutcome;
    onRecovered?: () => void;
  }) => Promise<boolean> | boolean;
}) {
  const taskSessionKey = params.ingressOpts.sessionKey?.trim();
  const shouldTrackTask = params.taskTrackingMode === "cli" && Boolean(taskSessionKey);
  let taskTracked = false;
  let taskStarted = false;
  let queueTaskId: string | undefined;
  let queueTaskRuntime: TaskRuntime | undefined;
  let queueTask: TaskRecord | undefined;
  let queueTaskOwnedByCore = false;
  const active = params.context.chatAbortControllers.get(params.runId);
  const activeOwnsDispatch =
    active?.controller === params.abortController &&
    active.kind === "agent" &&
    active.sessionKey === taskSessionKey;
  if (shouldTrackTask && taskSessionKey) {
    try {
      const task = createQueuedTaskRun({
        runtime: "cli",
        sourceId: params.runId,
        ownerKey: taskSessionKey,
        scopeKind: "session",
        requesterOrigin: normalizeDeliveryContext({
          channel: params.ingressOpts.channel,
          to: params.ingressOpts.to,
          accountId: params.ingressOpts.accountId,
          threadId: params.ingressOpts.threadId,
        }),
        childSessionKey: taskSessionKey,
        runId: params.runId,
        task: params.ingressOpts.message,
        deliveryStatus: "not_applicable",
      });
      queueTaskId = task?.taskId;
      queueTaskRuntime = task?.runtime;
      queueTask = task ?? undefined;
      queueTaskOwnedByCore = Boolean(queueTaskId && getTaskById(queueTaskId));
      taskTracked = Boolean(queueTaskId);
    } catch (err) {
      // Best-effort only: background task tracking must not block agent runs.
      // Still surface the swallowed error so non-transient tracking failures stay observable.
      params.context.logGateway.warn(
        `failed to start tracked agent task ${params.runId}: ${formatForLog(err)}`,
      );
    }
  } else if (taskSessionKey) {
    try {
      const coreTask = resolveActiveTaskByRunScope({
        runId: params.runId,
        sessionKey: taskSessionKey,
      });
      const task =
        coreTask ??
        (activeOwnsDispatch && active
          ? findDetachedTaskRunAcrossRuntimes({
              runId: params.runId,
              sessionKey: taskSessionKey,
              createdAtOrAfter: active.startedAtMs,
              createdBefore: Date.now() + 1,
            })
          : undefined);
      if (task && isActiveTaskStatus(task.status)) {
        queueTaskId = task.taskId;
        queueTaskRuntime = task.runtime;
        queueTask = task;
        queueTaskOwnedByCore = Boolean(getTaskById(task.taskId));
      }
    } catch (err) {
      params.context.logGateway.warn(
        `failed to attach tracked agent task ${params.runId}: ${formatForLog(err)}`,
      );
    }
  }
  if (queueTask && activeOwnsDispatch && active) {
    active.taskId = queueTask.taskId;
    active.detachedTask = queueTask;
  }
  const settle = async (outcome: {
    terminalOutcome: AgentRunTerminalOutcome;
    onRecovered?: () => void;
  }): Promise<boolean> => {
    try {
      return (await params.onSettled?.(outcome)) ?? true;
    } catch (error) {
      params.context.logGateway.warn(
        `failed to settle agent continuation ${params.runId}: ${formatForLog(error)}`,
      );
      return false;
    }
  };
  const cronCreatorAuthorityCapability = params.cronCreatorAuthority
    ? createCronCreatorAuthorityCapability(
        params.cronCreatorAuthority.runId,
        params.cronCreatorAuthority.callerOrigin,
      )
    : undefined;
  const activeOwnsSessionProjection =
    Boolean(taskSessionKey) &&
    active?.controller === params.abortController &&
    active.sessionKey === taskSessionKey &&
    active.controlUiVisible !== false &&
    active.projectSessionActive !== false;
  const publishSessionRunActivity = () => {
    if (!activeOwnsSessionProjection || !taskSessionKey) {
      return;
    }
    emitSessionsChanged(params.context, {
      sessionKey: taskSessionKey,
      ...(active?.agentId ? { agentId: active.agentId } : {}),
      reason: "run-activity",
    });
  };
  const onExecutionStarted = () => {
    params.ingressOpts.onExecutionStarted?.();
    if (queueTaskId && taskSessionKey && queueTaskRuntime && !taskStarted) {
      taskStarted = true;
      try {
        const startedAt = Date.now();
        if (queueTaskOwnedByCore) {
          markTaskRunningById({
            taskId: queueTaskId,
            startedAt,
            lastEventAt: startedAt,
          });
        } else {
          startTaskRunByRunId({
            runId: params.runId,
            runtime: queueTaskRuntime,
            sessionKey: taskSessionKey,
            startedAt,
            lastEventAt: startedAt,
          });
        }
      } catch (err) {
        params.context.logGateway.warn(
          `failed to mark tracked agent task ${params.runId} running: ${formatForLog(err)}`,
        );
      }
    }
    publishSessionRunActivity();
  };
  const onQueueStateChange = () => {
    params.ingressOpts.onQueueStateChange?.();
    if (queueTaskId) {
      publishTaskProjectionById(queueTaskId);
    }
    publishSessionRunActivity();
  };
  const runAgent = () =>
    agentCommandFromGatewayIngress(
      {
        ...params.ingressOpts,
        ...(cronCreatorAuthorityCapability ? { cronCreatorAuthorityCapability } : {}),
        queueWorkId: queueTaskId ?? params.runId,
        onExecutionStarted,
        onQueueStateChange,
      },
      defaultRuntime,
      params.context.deps,
      {
        restoreAdmittedRecovery: params.restoreAdmittedRecovery,
      },
    );
  const agentRun = cronCreatorAuthorityCapability
    ? runWithCronCreatorAuthorityCapability(
        cronCreatorAuthorityCapability,
        runAgent,
        params.abortController.signal,
      )
    : runAgent();
  void agentRun
    .then(async (result) => {
      const recordedOutcome = readAgentRunTerminalOutcome(result);
      const signalStopReason = resolveResolvedAgentTimeoutStopReason(
        result?.meta,
        params.abortController.signal,
      );
      const aborted = result?.meta?.aborted === true || signalStopReason !== undefined;
      const stopReason = signalStopReason
        ? signalStopReason
        : aborted
          ? (result?.meta?.stopReason ?? "rpc")
          : undefined;
      const timeoutPhase = normalizeAgentRunTimeoutPhase(result?.meta?.timeoutPhase);
      const terminalOutcome = buildAgentRunTerminalOutcome({
        status:
          aborted || result?.meta?.stopReason === "timeout" || timeoutPhase
            ? "timeout"
            : recordedOutcome === "failed" ||
                result?.meta?.error ||
                result?.meta?.stopReason === "error"
              ? "error"
              : "ok",
        error: result?.meta?.error,
        stopReason: stopReason ?? result?.meta?.stopReason,
        livenessState: result?.meta?.livenessState,
        timeoutPhase,
        providerStarted: result?.meta?.providerStarted,
      });
      const responseStatus =
        RESOLVED_GATEWAY_STATUS_BY_TERMINAL_CLASSIFICATION[
          classifyAgentRunTerminalOutcome(terminalOutcome)
        ];
      if (taskTracked && taskSessionKey) {
        tryFinalizeTrackedAgentTask({
          runId: params.runId,
          sessionKey: taskSessionKey,
          status: mapAgentRunTerminalOutcomeToTaskStatus(terminalOutcome),
          terminalSummary:
            responseStatus === "timeout"
              ? "aborted"
              : responseStatus === "error"
                ? "failed"
                : "completed",
          log: params.context.logGateway,
        });
      }
      const payload = {
        runId: params.runId,
        status: responseStatus,
        summary:
          responseStatus === "timeout"
            ? "aborted"
            : responseStatus === "error"
              ? "failed"
              : "completed",
        ...(responseStatus !== "ok" && terminalOutcome.stopReason
          ? { stopReason: terminalOutcome.stopReason }
          : {}),
        ...(responseStatus === "timeout" && terminalOutcome.timeoutPhase
          ? { timeoutPhase: terminalOutcome.timeoutPhase }
          : {}),
        ...(responseStatus === "timeout" && terminalOutcome.providerStarted !== undefined
          ? { providerStarted: terminalOutcome.providerStarted }
          : {}),
        result,
      };
      const persistTerminalDedupe = () => {
        setGatewayDedupeEntries({
          dedupe: params.context.dedupe,
          keys: params.dedupeKeys,
          entry: {
            ts: Date.now(),
            ok: true,
            payload,
          },
        });
      };
      const settled = await settle({ terminalOutcome, onRecovered: persistTerminalDedupe });
      if (!settled) {
        const summary = "failed to persist cron continuation settlement";
        const error = errorShape(ErrorCodes.UNAVAILABLE, summary);
        const failedPayload = { runId: params.runId, status: "error" as const, summary };
        setGatewayDedupeEntries({
          dedupe: params.context.dedupe,
          keys: params.dedupeKeys,
          entry: { ts: Date.now(), ok: false, payload: failedPayload, error },
        });
        params.io.emitFinal([false, failedPayload, error], {
          runId: params.runId,
          error: summary,
        });
        return;
      }
      persistTerminalDedupe();
      // Send a second res frame (same id) so TS clients with expectFinal can wait.
      // Swift clients will typically treat the first res as the result and ignore this.
      params.io.emitFinal([true, payload, undefined], { runId: params.runId });
    })
    .catch(async (err: unknown) => {
      const aborted = isGatewayAgentAbortRejection(err, params.abortController.signal);
      const renderedErr = formatErrorMessageWithCode(err);
      const stopReason = aborted
        ? resolveGatewayAgentAbortStopReason(params.abortController.signal)
        : isAbortError(err)
          ? "aborted"
          : undefined;
      const terminalOutcome = buildAgentRunTerminalOutcome({
        status: aborted || isTimeoutError(err) ? "timeout" : "error",
        error: renderedErr,
        stopReason,
        timeoutPhase: stopReason === "restart" ? "gateway_draining" : undefined,
      });
      const responseStatus = projectRejectedGatewayStatus(terminalOutcome);
      if (taskTracked && taskSessionKey) {
        const currentTask = queueTaskId ? getTaskById(queueTaskId) : undefined;
        const preserveCancellationError =
          aborted && currentTask?.status === "cancelled" && Boolean(currentTask.error?.trim());
        tryFinalizeTrackedAgentTask({
          runId: params.runId,
          sessionKey: taskSessionKey,
          status: mapAgentRunTerminalOutcomeToTaskStatus(terminalOutcome),
          ...(preserveCancellationError ? {} : { error: renderedErr }),
          terminalSummary: renderedErr,
          log: params.context.logGateway,
        });
      }
      const error = errorShape(ErrorCodes.UNAVAILABLE, renderedErr);
      Object.defineProperty(error, "cause", { value: err });
      const payload = {
        runId: params.runId,
        status: responseStatus,
        summary: aborted ? "aborted" : renderedErr,
        ...(aborted
          ? {
              stopReason,
              ...(terminalOutcome.timeoutPhase
                ? { timeoutPhase: terminalOutcome.timeoutPhase }
                : {}),
            }
          : {}),
      };
      const persistTerminalDedupe = (settlementPersisted: boolean) => {
        setGatewayDedupeEntries({
          dedupe: params.context.dedupe,
          keys: params.dedupeKeys,
          entry: {
            ts: Date.now(),
            ok: aborted && settlementPersisted,
            payload,
            ...(aborted ? {} : { error }),
          },
        });
      };
      const settled = await settle({
        terminalOutcome,
        onRecovered: () => persistTerminalDedupe(true),
      });
      persistTerminalDedupe(settled);
      params.io.emitFinal([aborted && settled, payload, aborted && settled ? undefined : error], {
        runId: params.runId,
        ...(aborted ? {} : { error: renderedErr }),
      });
    })
    .finally(() => {
      clearAgentRunContext(params.runId, params.ingressOpts.lifecycleGeneration);
      params.cleanupAbortController();
    });
}
