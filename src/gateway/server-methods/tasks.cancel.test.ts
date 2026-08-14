import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  cancelPendingCommandByWorkId,
  enqueueCommandInLane,
  getCommandQueueWorkSnapshot,
  setCommandLaneConcurrency,
} from "../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { getDetachedTaskLifecycleRuntime } from "../../tasks/detached-task-runtime.js";
import {
  createTaskRecord as createTaskRecordOrNull,
  getTaskById,
} from "../../tasks/runtime-internal.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import {
  resetDetachedTaskLifecycleRuntimeForTests,
  resetTaskRegistryControlRuntimeForTests,
  resetTaskRegistryForTests,
  setDetachedTaskLifecycleRuntime,
  setTaskRegistryControlRuntimeForTests,
} from "../../tasks/task-runtime.test-helpers.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { registerChatAbortController, type ChatAbortControllerEntry } from "../chat-abort.js";
import { createChatRunState } from "../server-chat-state.js";
import { tasksHandlers } from "./tasks.js";
import type { RespondFn } from "./types.js";

const stateDirEnvSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);

type TaskResponsePayload = {
  task?: Record<string, unknown>;
  found?: boolean;
  cancelled?: boolean;
  reason?: string;
};

let stateDir: string;

function createTaskRecord(params: Parameters<typeof createTaskRecordOrNull>[0]): TaskRecord {
  const task = createTaskRecordOrNull(params);
  if (!task) {
    throw new Error("expected task creation to succeed");
  }
  return task;
}

function createAbortContext(chatAbortControllers: Map<string, ChatAbortControllerEntry>) {
  return {
    chatAbortControllers,
    chatRunState: createChatRunState(),
    removeChatRun: vi.fn(),
    agentRunSeq: new Map<string, number>(),
    broadcast: vi.fn(),
    nodeSendToSession: vi.fn(),
    cancelRunBoundApprovals: vi.fn(),
  };
}

async function runTaskHandler(
  method: "tasks.get" | "tasks.cancel",
  params: Record<string, unknown>,
  contextOverrides: Record<string, unknown> = {},
) {
  const calls: Parameters<RespondFn>[] = [];
  const respond: RespondFn = (...args) => {
    calls.push(args);
  };
  await expectDefined(
    tasksHandlers[method],
    "tasksHandlers[method] test invariant",
  )({
    req: { type: "req", id: `req-${method}`, method },
    params,
    respond,
    context: {
      getRuntimeConfig: () => ({}),
      ...contextOverrides,
    } as never,
    client: null,
    isWebchatConnect: () => false,
  });
  return {
    calls,
    payload: calls[0]?.[1] as TaskResponsePayload | undefined,
  };
}

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-task-cancel-"));
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  resetTaskRegistryForTests();
  resetCommandQueueStateForTest();
});

afterEach(async () => {
  resetDetachedTaskLifecycleRuntimeForTests();
  resetTaskRegistryControlRuntimeForTests();
  resetTaskRegistryForTests();
  resetCommandQueueStateForTest();
  stateDirEnvSnapshot.restore();
  await fs.rm(stateDir, { recursive: true, force: true });
});

describe("tasks.cancel CLI ownership", () => {
  it("keeps background exec cancellation on its process-control owner", async () => {
    const cancelBackgroundExecSession = vi.fn(() => true);
    setTaskRegistryControlRuntimeForTests({
      cancelBackgroundExecSession,
      cancelActiveCronTaskRun: () => false,
      getAcpSessionManager: () => ({ cancelSession: async () => {} }),
      killSubagentRunAdmin: async () => ({ found: false, killed: false }),
    });
    const task = createTaskRecord({
      runtime: "cli",
      taskKind: "exec",
      sourceId: "amber-reef",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      runId: "exec:amber-reef",
      task: "Background CLI command",
      status: "running",
      deliveryStatus: "not_applicable",
    });

    const { payload } = await runTaskHandler("tasks.cancel", {
      taskId: task.taskId,
      reason: "operator stopped command",
    });

    expect(cancelBackgroundExecSession).toHaveBeenCalledWith("amber-reef");
    expect(payload).toMatchObject({
      found: true,
      cancelled: true,
      task: {
        id: task.taskId,
        status: "cancelled",
        error: "operator stopped command",
      },
    });
    expect(getTaskById(task.taskId)).toMatchObject({
      status: "cancelled",
      error: "operator stopped command",
    });
  });

  it("keeps queued ACP work intact when its session owner refuses cancellation", async () => {
    const cancelSession = vi.fn(async () => {
      throw new Error("ACP cancellation refused");
    });
    setTaskRegistryControlRuntimeForTests({
      cancelActiveCronTaskRun: () => false,
      getAcpSessionManager: () => ({ cancelSession }),
      killSubagentRunAdmin: async () => ({ found: false, killed: false }),
    });
    const lane = "tasks-cancel-acp-owner-refusal";
    setCommandLaneConcurrency(lane, 0);
    const sessionKey = "agent:codex:acp:owner-refusal";
    const runId = "run-acp-owner-refusal";
    const task = createTaskRecord({
      runtime: "acp",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: sessionKey,
      runId,
      task: "ACP owner must accept first",
      status: "running",
      deliveryStatus: "pending",
    });
    const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
    const registration = registerChatAbortController({
      chatAbortControllers,
      runId,
      taskId: task.taskId,
      sessionId: "session-acp-owner-refusal",
      sessionKey,
      timeoutMs: 60_000,
      controlUiVisible: false,
      kind: "agent",
    });
    const queuedRun = enqueueCommandInLane(lane, async () => {}, { workId: task.taskId });

    const { payload } = await runTaskHandler(
      "tasks.cancel",
      { taskId: task.taskId },
      { chatAbortControllers },
    );

    expect(cancelSession).toHaveBeenCalledOnce();
    expect(payload).toMatchObject({
      found: true,
      cancelled: false,
      reason: "ACP cancellation refused",
    });
    expect(registration.controller.signal.aborted).toBe(false);
    expect(getCommandQueueWorkSnapshot().has(task.taskId)).toBe(true);
    expect(getTaskById(task.taskId)?.status).toBe("running");

    setCommandLaneConcurrency(lane, 1);
    await queuedRun;
    registration.cleanup({ force: true });
  });

  it("holds mirrored custom work until its runtime accepts cancellation", async () => {
    const lane = "tasks-cancel-mirrored-custom-runtime";
    setCommandLaneConcurrency(lane, 0);
    const runId = "run-mirrored-custom-runtime";
    const sessionKey = "agent:codex:acp:mirrored-custom-runtime";
    const task = createTaskRecord({
      runtime: "acp",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: sessionKey,
      runId,
      task: "Mirrored custom task",
      status: "queued",
      deliveryStatus: "pending",
    });
    const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
    const registration = registerChatAbortController({
      chatAbortControllers,
      runId,
      taskId: task.taskId,
      sessionId: "session-mirrored-custom-runtime",
      sessionKey,
      timeoutMs: 60_000,
      controlUiVisible: false,
      kind: "agent",
    });
    const cancellationStarted = createDeferred<void>();
    const acceptCancellation = createDeferred<void>();
    const customCancel = vi.fn(async () => {
      cancellationStarted.resolve();
      await acceptCancellation.promise;
      return {
        found: true,
        cancelled: true,
        task: { ...task, status: "cancelled" as const, endedAt: Date.now() },
      };
    });
    setDetachedTaskLifecycleRuntime({
      ...getDetachedTaskLifecycleRuntime(),
      findTaskRun: (params) => (params.runtime === task.runtime ? task : undefined),
      cancelDetachedTaskRunById: customCancel,
    });
    let executed = false;
    const queuedRun = enqueueCommandInLane(
      lane,
      async () => {
        executed = true;
      },
      { workId: task.taskId },
    );
    const queuedRejection = expect(queuedRun).rejects.toMatchObject({ name: "AbortError" });

    const cancellation = runTaskHandler(
      "tasks.cancel",
      { taskId: task.taskId },
      createAbortContext(chatAbortControllers),
    );
    await cancellationStarted.promise;
    setCommandLaneConcurrency(lane, 1);
    await Promise.resolve();

    expect(executed).toBe(false);
    expect(getCommandQueueWorkSnapshot().has(task.taskId)).toBe(true);

    acceptCancellation.resolve();
    const { payload } = await cancellation;
    await queuedRejection;

    expect(payload).toMatchObject({
      found: true,
      cancelled: true,
      task: { id: task.taskId, status: "cancelled" },
    });
    expect(customCancel).toHaveBeenCalledOnce();
    expect(registration.controller.signal.aborted).toBe(true);
    expect(getCommandQueueWorkSnapshot().has(task.taskId)).toBe(false);
    expect(executed).toBe(false);
    registration.cleanup({ force: true });
  });

  it("holds non-mirrored custom work until its runtime accepts cancellation", async () => {
    const lane = "tasks-cancel-non-mirrored-custom-runtime";
    setCommandLaneConcurrency(lane, 0);
    const runId = "run-non-mirrored-custom-runtime";
    const sessionKey = "agent:codex:acp:non-mirrored-custom-runtime";
    const task: TaskRecord = {
      taskId: "task-non-mirrored-custom-runtime",
      runtime: "acp",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: sessionKey,
      runId,
      task: "Custom runtime task stays queued",
      status: "queued",
      deliveryStatus: "pending",
      notifyPolicy: "done_only",
      createdAt: Date.now(),
    };
    const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
    const registration = registerChatAbortController({
      chatAbortControllers,
      runId,
      taskId: task.taskId,
      sessionId: "session-non-mirrored-custom-runtime",
      sessionKey,
      timeoutMs: 60_000,
      controlUiVisible: false,
      kind: "agent",
      now: task.createdAt - 1,
    });
    expectDefined(
      chatAbortControllers.get(runId),
      "non-mirrored controller entry missing",
    ).detachedTask = task;
    const cancellationStarted = createDeferred<void>();
    const acceptCancellation = createDeferred<void>();
    const customCancel = vi.fn(async () => {
      cancellationStarted.resolve();
      await acceptCancellation.promise;
      task.status = "cancelled";
      task.endedAt = Date.now();
      return { found: true, cancelled: true, task };
    });
    setDetachedTaskLifecycleRuntime({
      ...getDetachedTaskLifecycleRuntime(),
      findTaskRun: (params) => (params.runtime === task.runtime ? task : undefined),
      cancelDetachedTaskRunById: customCancel,
    });
    let executed = false;
    const queuedRun = enqueueCommandInLane(
      lane,
      async () => {
        executed = true;
      },
      { workId: task.taskId },
    );
    const queuedRejection = expect(queuedRun).rejects.toMatchObject({ name: "AbortError" });

    const cancellation = runTaskHandler(
      "tasks.cancel",
      { taskId: task.taskId },
      createAbortContext(chatAbortControllers),
    );
    await cancellationStarted.promise;
    setCommandLaneConcurrency(lane, 1);
    await Promise.resolve();

    expect(executed).toBe(false);
    expect(getCommandQueueWorkSnapshot().has(task.taskId)).toBe(true);

    acceptCancellation.resolve();
    const { payload } = await cancellation;
    await queuedRejection;

    expect(customCancel).toHaveBeenCalledOnce();
    expect(payload).toMatchObject({
      found: true,
      cancelled: true,
      task: {
        id: task.taskId,
        status: "cancelled",
      },
    });
    expect(registration.controller.signal.aborted).toBe(true);
    expect(getCommandQueueWorkSnapshot().has(task.taskId)).toBe(false);
    expect(executed).toBe(false);
    registration.cleanup({ force: true });
  });

  it("falls through to coordinated core cancellation when a custom runtime does not own the task", async () => {
    const lane = "tasks-cancel-custom-runtime-core-fallback";
    setCommandLaneConcurrency(lane, 0);
    const runId = "run-custom-runtime-core-fallback";
    const sessionKey = "agent:main:main";
    const task = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: sessionKey,
      ownerKey: sessionKey,
      scopeKind: "session",
      childSessionKey: sessionKey,
      runId,
      task: "Core owns this task",
      status: "queued",
      deliveryStatus: "not_applicable",
    });
    const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
    const registration = registerChatAbortController({
      chatAbortControllers,
      runId,
      taskId: task.taskId,
      sessionId: "session-custom-runtime-core-fallback",
      sessionKey,
      timeoutMs: 60_000,
      controlUiVisible: false,
      kind: "agent",
    });
    const customCancel = vi.fn(async () => ({ found: false, cancelled: false }));
    setDetachedTaskLifecycleRuntime({
      ...getDetachedTaskLifecycleRuntime(),
      cancelDetachedTaskRunById: customCancel,
    });
    let executed = false;
    const queuedRun = enqueueCommandInLane(
      lane,
      async () => {
        executed = true;
      },
      { workId: task.taskId },
    );
    const queuedRejection = expect(queuedRun).rejects.toMatchObject({ name: "AbortError" });

    const { payload } = await runTaskHandler(
      "tasks.cancel",
      { taskId: task.taskId, reason: "operator stopped core task" },
      createAbortContext(chatAbortControllers),
    );
    await queuedRejection;

    expect(customCancel).toHaveBeenCalledOnce();
    expect(payload).toMatchObject({
      found: true,
      cancelled: true,
      task: { id: task.taskId, status: "cancelled", error: "operator stopped core task" },
    });
    expect(registration.controller.signal.aborted).toBe(true);
    expect(getCommandQueueWorkSnapshot().has(task.taskId)).toBe(false);
    expect(executed).toBe(false);
    registration.cleanup({ force: true });
  });

  it("does not abort a reused controller after custom cancellation is accepted", async () => {
    const lane = "tasks-cancel-custom-runtime-controller-reuse";
    setCommandLaneConcurrency(lane, 0);
    const runId = "run-custom-runtime-controller-reuse";
    const sessionKey = "agent:main:main";
    const task = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: sessionKey,
      ownerKey: sessionKey,
      scopeKind: "session",
      childSessionKey: sessionKey,
      runId,
      task: "Original controller task",
      status: "queued",
      deliveryStatus: "not_applicable",
    });
    const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
    const original = registerChatAbortController({
      chatAbortControllers,
      runId,
      taskId: task.taskId,
      sessionId: "session-custom-runtime-controller-original",
      sessionKey,
      timeoutMs: 60_000,
      controlUiVisible: false,
      kind: "agent",
    });
    const cancellationStarted = createDeferred<void>();
    const acceptCancellation = createDeferred<void>();
    setDetachedTaskLifecycleRuntime({
      ...getDetachedTaskLifecycleRuntime(),
      cancelDetachedTaskRunById: vi.fn(async () => {
        cancellationStarted.resolve();
        await acceptCancellation.promise;
        return { found: true, cancelled: true };
      }),
    });
    const queuedRun = enqueueCommandInLane(lane, async () => {}, { workId: task.taskId });
    const queuedRejection = expect(queuedRun).rejects.toMatchObject({ name: "AbortError" });

    const cancellation = runTaskHandler(
      "tasks.cancel",
      { taskId: task.taskId },
      { chatAbortControllers },
    );
    await cancellationStarted.promise;
    original.cleanup({ force: true });
    const newer = registerChatAbortController({
      chatAbortControllers,
      runId,
      taskId: task.taskId,
      sessionId: "session-custom-runtime-controller-newer",
      sessionKey,
      timeoutMs: 60_000,
      controlUiVisible: false,
      kind: "agent",
    });

    acceptCancellation.resolve();
    const { payload } = await cancellation;
    await queuedRejection;

    expect(payload).toMatchObject({ found: true, cancelled: true });
    expect(original.controller.signal.aborted).toBe(false);
    expect(newer.controller.signal.aborted).toBe(false);
    expect(chatAbortControllers.get(runId)?.controller).toBe(newer.controller);
    expect(getCommandQueueWorkSnapshot().has(task.taskId)).toBe(false);
    newer.cleanup({ force: true });
  });

  it("rejects a mismatched custom task behind a requested Gateway task id", async () => {
    const lane = "tasks-cancel-custom-runtime-task-id-mismatch";
    setCommandLaneConcurrency(lane, 0);
    const runId = "run-custom-runtime-task-id-mismatch";
    const sessionKey = "agent:codex:acp:custom-runtime-task-id-mismatch";
    const requestedTaskId = "task-requested-custom-runtime";
    const mismatchedTask: TaskRecord = {
      taskId: "task-different-custom-runtime",
      runtime: "acp",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: sessionKey,
      runId,
      task: "Different custom runtime task",
      status: "queued",
      deliveryStatus: "pending",
      notifyPolicy: "done_only",
      createdAt: Date.now(),
    };
    const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
    const registration = registerChatAbortController({
      chatAbortControllers,
      runId,
      taskId: requestedTaskId,
      sessionId: "session-custom-runtime-task-id-mismatch",
      sessionKey,
      timeoutMs: 60_000,
      controlUiVisible: false,
      kind: "agent",
      now: mismatchedTask.createdAt - 1,
    });
    const customCancel = vi.fn(async () => ({ found: true, cancelled: true }));
    setDetachedTaskLifecycleRuntime({
      ...getDetachedTaskLifecycleRuntime(),
      findTaskRun: (params) =>
        params.runtime === mismatchedTask.runtime ? mismatchedTask : undefined,
      cancelDetachedTaskRunById: customCancel,
    });
    const queuedRun = enqueueCommandInLane(lane, async () => {}, { workId: requestedTaskId });

    const { payload } = await runTaskHandler(
      "tasks.cancel",
      { taskId: requestedTaskId },
      { chatAbortControllers },
    );

    expect(customCancel).not.toHaveBeenCalled();
    expect(payload).toEqual({
      found: true,
      cancelled: false,
      reason: "Task runtime cannot coordinate Gateway queue cancellation.",
    });
    expect(registration.controller.signal.aborted).toBe(false);
    expect(getCommandQueueWorkSnapshot().has(requestedTaskId)).toBe(true);
    expect(mismatchedTask.status).toBe("queued");

    setCommandLaneConcurrency(lane, 1);
    await queuedRun;
    registration.cleanup({ force: true });
  });

  it("keeps queued subagent work when canonical completion wins the cancel race", async () => {
    const lane = "tasks-cancel-subagent-completion-race";
    setCommandLaneConcurrency(lane, 0);
    const sessionKey = "agent:main:subagent:completion-race";
    const runId = "run-subagent-completion-race";
    setTaskRegistryControlRuntimeForTests({
      cancelActiveCronTaskRun: () => false,
      getAcpSessionManager: () => ({ cancelSession: async () => {} }),
      killSubagentRunAdmin: async () => ({
        found: true,
        killed: false,
        runId,
        sessionKey,
        cascadeKilled: 0,
        targetState: {
          state: "terminal",
          task: { status: "succeeded", endedAt: 2_000, terminalSummary: "completed" },
        },
      }),
    });
    const task = createTaskRecord({
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: sessionKey,
      runId,
      task: "Completion wins",
      status: "running",
      deliveryStatus: "pending",
    });
    const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
    const registration = registerChatAbortController({
      chatAbortControllers,
      runId,
      taskId: task.taskId,
      sessionId: "session-subagent-completion-race",
      sessionKey,
      timeoutMs: 60_000,
      controlUiVisible: false,
      kind: "agent",
    });
    const queuedRun = enqueueCommandInLane(lane, async () => {}, { workId: task.taskId });

    const { payload } = await runTaskHandler(
      "tasks.cancel",
      { taskId: task.taskId },
      { chatAbortControllers },
    );

    expect(payload).toMatchObject({
      found: true,
      cancelled: false,
      reason: "Subagent completed while cancellation was in progress.",
    });
    expect(registration.controller.signal.aborted).toBe(false);
    expect(getCommandQueueWorkSnapshot().has(task.taskId)).toBe(true);
    expect(getTaskById(task.taskId)).toMatchObject({
      status: "succeeded",
      terminalSummary: "completed",
    });

    setCommandLaneConcurrency(lane, 1);
    await queuedRun;
    registration.cleanup({ force: true });
  });

  it("accepts subagent cancellation after its owner clears the preflight Gateway claim", async () => {
    const lane = "tasks-cancel-subagent-owner-clears-gateway";
    setCommandLaneConcurrency(lane, 0);
    const sessionKey = "agent:main:subagent:owner-clears-gateway";
    const runId = "run-subagent-owner-clears-gateway";
    const task = createTaskRecord({
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: sessionKey,
      runId,
      task: "Owner clears queued Gateway work",
      status: "running",
      deliveryStatus: "pending",
    });
    const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
    const original = registerChatAbortController({
      chatAbortControllers,
      runId,
      taskId: task.taskId,
      sessionId: "session-subagent-owner-clears-gateway",
      sessionKey,
      timeoutMs: 60_000,
      controlUiVisible: false,
      kind: "agent",
    });
    let providerExecuted = false;
    const queuedRun = enqueueCommandInLane(
      lane,
      async () => {
        providerExecuted = true;
      },
      { workId: task.taskId },
    );
    const queuedRejection = expect(queuedRun).rejects.toMatchObject({ name: "AbortError" });
    let newer: ReturnType<typeof registerChatAbortController> | undefined;
    setTaskRegistryControlRuntimeForTests({
      cancelActiveCronTaskRun: () => false,
      getAcpSessionManager: () => ({ cancelSession: async () => {} }),
      killSubagentRunAdmin: async () => {
        expect(cancelPendingCommandByWorkId(task.taskId)).toBe(1);
        original.cleanup({ force: true });
        newer = registerChatAbortController({
          chatAbortControllers,
          runId,
          taskId: "newer-task-id",
          sessionId: "session-newer-reused-run",
          sessionKey,
          timeoutMs: 60_000,
          controlUiVisible: false,
          kind: "agent",
        });
        return {
          found: true,
          killed: true,
          runId,
          sessionKey,
          cascadeKilled: 0,
        };
      },
    });

    const { payload } = await runTaskHandler(
      "tasks.cancel",
      { taskId: task.taskId, reason: "operator stopped subagent" },
      { chatAbortControllers },
    );

    expect(payload).toMatchObject({
      found: true,
      cancelled: true,
      task: {
        id: task.taskId,
        status: "cancelled",
        error: "operator stopped subagent",
      },
    });
    await queuedRejection;
    expect(providerExecuted).toBe(false);
    expect(original.controller.signal.aborted).toBe(false);
    const newerRegistration = expectDefined(newer, "newer controller registration");
    expect(newerRegistration.controller.signal.aborted).toBe(false);
    expect(chatAbortControllers.get(runId)?.taskId).toBe("newer-task-id");
    newerRegistration.cleanup({ force: true });
  });

  it("aborts an exact running CLI task before returning it as cancelled", async () => {
    const sessionKey = "agent:main:main";
    const runId = "run-cancel";
    const task = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: sessionKey,
      ownerKey: sessionKey,
      scopeKind: "session",
      childSessionKey: sessionKey,
      runId,
      task: "Cancelable task",
      status: "running",
      deliveryStatus: "pending",
    });
    const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
    const registration = registerChatAbortController({
      chatAbortControllers,
      runId,
      taskId: task.taskId,
      sessionId: "session-running-cli",
      sessionKey,
      timeoutMs: 60_000,
      controlUiVisible: false,
      kind: "agent",
    });

    const { calls, payload } = await runTaskHandler(
      "tasks.cancel",
      { taskId: task.taskId, reason: "user stopped task" },
      createAbortContext(chatAbortControllers),
    );

    expect(calls[0]?.[0]).toBe(true);
    expect(payload).toMatchObject({
      found: true,
      cancelled: true,
      task: {
        id: task.taskId,
        status: "cancelled",
        error: "user stopped task",
      },
    });
    expect(registration.controller.signal.aborted).toBe(true);
  });

  it("removes a queued CLI run before its lane callback can execute", async () => {
    const lane = "tasks-cancel-queued-cli";
    setCommandLaneConcurrency(lane, 1);
    const blockerStarted = createDeferred<void>();
    const releaseBlocker = createDeferred<void>();
    const blockerRun = enqueueCommandInLane(lane, async () => {
      blockerStarted.resolve();
      await releaseBlocker.promise;
    });
    await blockerStarted.promise;

    const runId = "run-cancel-queued-cli";
    const sessionKey = "agent:main:main";
    const task = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: sessionKey,
      ownerKey: sessionKey,
      scopeKind: "session",
      childSessionKey: sessionKey,
      runId,
      task: "Queued task must not execute",
      status: "queued",
      deliveryStatus: "not_applicable",
    });
    const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
    const registration = registerChatAbortController({
      chatAbortControllers,
      runId,
      taskId: task.taskId,
      sessionId: "session-cancel-queued-cli",
      sessionKey,
      timeoutMs: 60_000,
      controlUiVisible: false,
      kind: "agent",
    });
    let executed = false;
    const queuedRun = enqueueCommandInLane(
      lane,
      async () => {
        registration.controller.signal.throwIfAborted();
        executed = true;
      },
      { workId: task.taskId },
    );

    let laterRun: Promise<void> | undefined;
    try {
      const { payload } = await runTaskHandler(
        "tasks.cancel",
        { taskId: task.taskId },
        createAbortContext(chatAbortControllers),
      );

      expect(payload?.cancelled).toBe(true);
      expect(registration.controller.signal.aborted).toBe(true);
      await expect(queuedRun).rejects.toMatchObject({ name: "AbortError" });
      expect(getCommandQueueWorkSnapshot().has(task.taskId)).toBe(false);

      const laterTask = createTaskRecord({
        runtime: "cli",
        requesterSessionKey: sessionKey,
        ownerKey: sessionKey,
        scopeKind: "session",
        childSessionKey: sessionKey,
        runId: "run-after-cancelled-cli",
        task: "Later queued task",
        status: "queued",
        deliveryStatus: "not_applicable",
      });
      laterRun = enqueueCommandInLane(lane, async () => {}, { workId: laterTask.taskId });
      const laterSummary = (await runTaskHandler("tasks.get", { taskId: laterTask.taskId })).payload
        ?.task;
      expect(laterSummary?.queueWait).toMatchObject({ queuedAhead: 0, aheadBlockers: [] });
    } finally {
      releaseBlocker.resolve();
      await blockerRun;
      await laterRun;
      registration.cleanup({ force: true });
    }

    expect(executed).toBe(false);
  });

  it.each([
    ["newer reused agent", "agent", "task-new-live-run"],
    ["legacy unbound agent", "agent", undefined],
    ["non-agent", "chat-send", "task-stale-live-run"],
  ] as const)(
    "refuses to cancel a stale CLI task through a %s controller",
    async (_, kind, taskId) => {
      const runId = "run-reused-after-restart";
      const sessionKey = "agent:main:main";
      const staleTask = createTaskRecord({
        runtime: "cli",
        requesterSessionKey: sessionKey,
        ownerKey: sessionKey,
        scopeKind: "session",
        childSessionKey: sessionKey,
        runId,
        task: "Old durable task",
        status: "running",
        deliveryStatus: "not_applicable",
      });
      const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
      const newer = registerChatAbortController({
        chatAbortControllers,
        runId,
        taskId,
        sessionId: "session-new-live-run",
        sessionKey,
        timeoutMs: 60_000,
        controlUiVisible: false,
        kind,
      });

      const { payload } = await runTaskHandler(
        "tasks.cancel",
        { taskId: staleTask.taskId },
        { chatAbortControllers },
      );

      expect(payload).toMatchObject({
        found: true,
        cancelled: false,
        reason: "Task does not own the active Gateway cancellation handle.",
      });
      expect(newer.controller.signal.aborted).toBe(false);
      expect(chatAbortControllers.get(runId)?.taskId).toBe(taskId);
      expect(getTaskById(staleTask.taskId)?.status).toBe("running");
      newer.cleanup({ force: true });
    },
  );

  it("refuses an active CLI task without a live cancellation handle", async () => {
    const task = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:main:main",
      runId: "run-without-controller",
      task: "Missing live owner",
      status: "running",
      deliveryStatus: "not_applicable",
    });

    const { payload } = await runTaskHandler(
      "tasks.cancel",
      { taskId: task.taskId },
      { chatAbortControllers: new Map<string, ChatAbortControllerEntry>() },
    );

    expect(payload).toMatchObject({
      found: true,
      cancelled: false,
      reason: "CLI task has no pending queue entry or active Gateway cancellation handle.",
    });
    expect(getTaskById(task.taskId)?.status).toBe("running");
  });

  it("refuses an exact running CLI controller that is no longer abortable", async () => {
    const sessionKey = "agent:main:main";
    const runId = "run-non-abortable";
    const task = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: sessionKey,
      ownerKey: sessionKey,
      scopeKind: "session",
      childSessionKey: sessionKey,
      runId,
      task: "Finalizing live task",
      status: "running",
      deliveryStatus: "not_applicable",
    });
    const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
    const registration = registerChatAbortController({
      chatAbortControllers,
      runId,
      taskId: task.taskId,
      sessionId: "session-non-abortable",
      sessionKey,
      timeoutMs: 60_000,
      controlUiVisible: false,
      kind: "agent",
      isAbortable: () => false,
    });

    const { payload } = await runTaskHandler(
      "tasks.cancel",
      { taskId: task.taskId },
      { chatAbortControllers },
    );

    expect(payload).toMatchObject({
      found: true,
      cancelled: false,
      reason: "CLI task's active Gateway cancellation handle refused cancellation.",
    });
    expect(registration.controller.signal.aborted).toBe(false);
    expect(getTaskById(task.taskId)?.status).toBe("running");
    registration.cleanup({ force: true });
  });

  it("does not expose terminal task records as queue blockers", async () => {
    const lane = "task-summary-terminal-blocker";
    setCommandLaneConcurrency(lane, 0);
    const terminal = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:main:main",
      runId: "run-terminal-blocker",
      task: "Already cancelled",
      status: "cancelled",
      deliveryStatus: "not_applicable",
    });
    const target = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:main:main",
      runId: "run-after-terminal-blocker",
      task: "Still waiting",
      status: "queued",
      deliveryStatus: "not_applicable",
    });
    const staleTerminalRun = enqueueCommandInLane(lane, async () => {}, {
      workId: terminal.taskId,
    });
    const targetRun = enqueueCommandInLane(lane, async () => {}, { workId: target.taskId });

    const summary = (await runTaskHandler("tasks.get", { taskId: target.taskId })).payload?.task;
    expect(summary?.queueWait).toMatchObject({ queuedAhead: 1, aheadBlockers: [] });

    setCommandLaneConcurrency(lane, 1);
    await Promise.all([staleTerminalRun, targetRun]);
  });
});
