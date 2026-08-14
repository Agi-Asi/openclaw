import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { enqueueCommandInLane, setCommandLaneConcurrency } from "../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { getDetachedTaskLifecycleRuntime } from "../../tasks/detached-task-runtime.js";
import {
  createTaskRecord as createTaskRecordOrNull,
  getTaskById,
} from "../../tasks/runtime-internal.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import {
  resetDetachedTaskLifecycleRuntimeForTests,
  resetTaskRegistryForTests,
  setDetachedTaskLifecycleRuntime,
} from "../../tasks/task-runtime.test-helpers.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { registerChatAbortController, type ChatAbortControllerEntry } from "../chat-abort.js";
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

async function cancelTask(
  taskId: string,
  chatAbortControllers: Map<string, ChatAbortControllerEntry>,
) {
  const calls: Parameters<RespondFn>[] = [];
  await expectDefined(
    tasksHandlers["tasks.cancel"],
    "tasks.cancel test invariant",
  )({
    req: { type: "req", id: `cancel-${taskId}`, method: "tasks.cancel" },
    params: { taskId },
    respond: (...args) => calls.push(args),
    context: {
      getRuntimeConfig: () => ({}),
      chatAbortControllers,
    } as never,
    client: null,
    isWebchatConnect: () => false,
  });
  return calls[0]?.[1] as TaskResponsePayload | undefined;
}

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-custom-task-cancel-"));
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  resetTaskRegistryForTests();
  resetCommandQueueStateForTest();
});

afterEach(async () => {
  resetDetachedTaskLifecycleRuntimeForTests();
  resetTaskRegistryForTests();
  resetCommandQueueStateForTest();
  stateDirEnvSnapshot.restore();
  await fs.rm(stateDir, { recursive: true, force: true });
});

describe("tasks.cancel custom runtime release", () => {
  it("releases held work in FIFO order when its runtime refuses cancellation", async () => {
    const lane = "tasks-cancel-custom-runtime-refusal";
    setCommandLaneConcurrency(lane, 0);
    const runId = "run-custom-runtime-refusal";
    const sessionKey = "agent:main:main";
    const task = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: sessionKey,
      ownerKey: sessionKey,
      scopeKind: "session",
      childSessionKey: sessionKey,
      runId,
      task: "Custom runtime refuses cancellation",
      status: "queued",
      deliveryStatus: "not_applicable",
    });
    const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
    const registration = registerChatAbortController({
      chatAbortControllers,
      runId,
      taskId: task.taskId,
      sessionId: "session-custom-runtime-refusal",
      sessionKey,
      timeoutMs: 60_000,
      controlUiVisible: false,
      kind: "agent",
    });
    const cancellationStarted = createDeferred<void>();
    const refuseCancellation = createDeferred<void>();
    setDetachedTaskLifecycleRuntime({
      ...getDetachedTaskLifecycleRuntime(),
      cancelDetachedTaskRunById: vi.fn(async () => {
        cancellationStarted.resolve();
        await refuseCancellation.promise;
        return { found: true, cancelled: false, reason: "runtime refused cancel", task };
      }),
    });
    const order: string[] = [];
    const queuedRun = enqueueCommandInLane(
      lane,
      async () => {
        order.push("target");
      },
      { workId: task.taskId },
    );
    const laterRun = enqueueCommandInLane(lane, async () => {
      order.push("later");
    });

    const cancellation = cancelTask(task.taskId, chatAbortControllers);
    await cancellationStarted.promise;
    setCommandLaneConcurrency(lane, 1);
    await Promise.resolve();
    expect(order).toEqual([]);

    refuseCancellation.resolve();
    const payload = await cancellation;
    await Promise.all([queuedRun, laterRun]);

    expect(payload).toMatchObject({
      found: true,
      cancelled: false,
      reason: "runtime refused cancel",
    });
    expect(order).toEqual(["target", "later"]);
    expect(registration.controller.signal.aborted).toBe(false);
    expect(getTaskById(task.taskId)?.status).toBe("queued");
    registration.cleanup({ force: true });
  });

  it("releases held work when its runtime cancellation throws", async () => {
    const lane = "tasks-cancel-custom-runtime-throw";
    setCommandLaneConcurrency(lane, 0);
    const runId = "run-custom-runtime-throw";
    const sessionKey = "agent:main:main";
    const task = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: sessionKey,
      ownerKey: sessionKey,
      scopeKind: "session",
      childSessionKey: sessionKey,
      runId,
      task: "Custom runtime throws during cancellation",
      status: "queued",
      deliveryStatus: "not_applicable",
    });
    const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
    const registration = registerChatAbortController({
      chatAbortControllers,
      runId,
      taskId: task.taskId,
      sessionId: "session-custom-runtime-throw",
      sessionKey,
      timeoutMs: 60_000,
      controlUiVisible: false,
      kind: "agent",
    });
    const cancellationStarted = createDeferred<void>();
    const throwCancellation = createDeferred<void>();
    setDetachedTaskLifecycleRuntime({
      ...getDetachedTaskLifecycleRuntime(),
      cancelDetachedTaskRunById: vi.fn(async () => {
        cancellationStarted.resolve();
        await throwCancellation.promise;
        throw new Error("custom cancellation failed");
      }),
    });
    let executed = false;
    const queuedRun = enqueueCommandInLane(
      lane,
      async () => {
        executed = true;
      },
      { workId: task.taskId },
    );

    const cancellation = cancelTask(task.taskId, chatAbortControllers);
    await cancellationStarted.promise;
    setCommandLaneConcurrency(lane, 1);
    await Promise.resolve();
    expect(executed).toBe(false);

    throwCancellation.resolve();
    const payload = await cancellation;
    await queuedRun;

    expect(payload).toMatchObject({
      found: true,
      cancelled: false,
      reason: "custom cancellation failed",
    });
    expect(executed).toBe(true);
    expect(registration.controller.signal.aborted).toBe(false);
    registration.cleanup({ force: true });
  });
});
