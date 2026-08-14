import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  acquirePendingCommandAdmissionHoldByWorkId,
  cancelPendingCommandByWorkId,
  enqueueCommandInLane,
  getCommandQueueWorkSnapshot,
  resetAllLanes,
  resetCommandLane,
  setCommandLaneConcurrency,
} from "./command-queue.js";
import { hasPendingCommandByWorkId } from "./command-queue.pending-cancellation.js";
import { resetCommandQueueStateForTest } from "./command-queue.test-support.js";

describe("pending command cancellation", () => {
  beforeEach(() => {
    resetCommandQueueStateForTest();
  });

  it("removes exact pending work, settles it, and advances the next wait", async () => {
    const lane = `cancel-pending-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setCommandLaneConcurrency(lane, 0);
    let cancelledExecuted = false;
    const cancelledStateChange = vi.fn();
    const laterStateChange = vi.fn();
    const cancelled = enqueueCommandInLane(
      lane,
      async () => {
        cancelledExecuted = true;
      },
      { workId: "work-cancelled", onQueueStateChange: cancelledStateChange },
    );
    const later = enqueueCommandInLane(lane, async () => "later", {
      workId: "work-later",
      onQueueStateChange: laterStateChange,
    });
    await vi.waitFor(() => expect(laterStateChange).toHaveBeenCalled());
    cancelledStateChange.mockClear();
    laterStateChange.mockClear();

    expect(getCommandQueueWorkSnapshot().get("work-later")).toMatchObject({
      queuedAhead: 1,
      queuedAheadWorkIds: ["work-cancelled"],
    });
    expect(hasPendingCommandByWorkId("work-cancelled")).toBe(true);
    expect(cancelPendingCommandByWorkId("work-cancelled")).toBe(1);
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => {
      expect(cancelledStateChange).toHaveBeenCalledTimes(1);
      expect(laterStateChange).toHaveBeenCalledTimes(1);
    });
    expect(cancelledExecuted).toBe(false);
    expect(getCommandQueueWorkSnapshot().has("work-cancelled")).toBe(false);
    expect(hasPendingCommandByWorkId("work-cancelled")).toBe(false);
    expect(getCommandQueueWorkSnapshot().get("work-later")).toMatchObject({
      queuedAhead: 0,
      queuedAheadWorkIds: [],
    });

    setCommandLaneConcurrency(lane, 1);
    await expect(later).resolves.toBe("later");
  });

  it("does not remove active work", async () => {
    const lane = `cancel-active-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    const active = enqueueCommandInLane(
      lane,
      async () => {
        started.resolve();
        await release.promise;
        return "active";
      },
      { workId: "work-active" },
    );
    await started.promise;

    expect(hasPendingCommandByWorkId("work-active")).toBe(false);
    expect(cancelPendingCommandByWorkId("work-active")).toBe(0);
    release.resolve();
    await expect(active).resolves.toBe("active");
  });

  it("holds exact pending work in FIFO position until release", async () => {
    const lane = `hold-pending-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const blockerStarted = createDeferred<void>();
    const releaseBlocker = createDeferred<void>();
    const order: string[] = [];
    const blocker = enqueueCommandInLane(lane, async () => {
      blockerStarted.resolve();
      await releaseBlocker.promise;
      order.push("blocker");
    });
    await blockerStarted.promise;
    const held = enqueueCommandInLane(
      lane,
      async () => {
        order.push("held");
      },
      { workId: "work-held" },
    );
    const later = enqueueCommandInLane(lane, async () => {
      order.push("later");
    });
    const hold = acquirePendingCommandAdmissionHoldByWorkId("work-held");
    expect(hold).toBeDefined();

    releaseBlocker.resolve();
    await blocker;
    expect(order).toEqual(["blocker"]);
    expect(cancelPendingCommandByWorkId("work-held")).toBe(0);

    hold?.release();
    await Promise.all([held, later]);
    expect(order).toEqual(["blocker", "held", "later"]);
  });

  it.each([
    ["one lane", (lane: string) => resetCommandLane(lane)],
    ["all lanes", () => resetAllLanes()],
  ])("invalidates an admission hold when resetting %s", async (_scope, reset) => {
    const lane = `reset-held-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setCommandLaneConcurrency(lane, 0);
    let executed = false;
    const held = enqueueCommandInLane(
      lane,
      async () => {
        executed = true;
      },
      { workId: "work-held-across-reset" },
    );
    const hold = acquirePendingCommandAdmissionHoldByWorkId("work-held-across-reset");
    expect(hold).toBeDefined();

    try {
      reset(lane);
      expect(hold?.commitCancellation()).toBe(0);

      setCommandLaneConcurrency(lane, 1);
      await held;
      expect(executed).toBe(true);
    } finally {
      hold?.release();
      setCommandLaneConcurrency(lane, 1);
      await held.catch(() => {});
    }
  });

  it("commits cancellation for only the entry owned by an admission hold", async () => {
    const lane = `commit-held-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const blockerStarted = createDeferred<void>();
    const releaseBlocker = createDeferred<void>();
    let heldExecuted = false;
    const blocker = enqueueCommandInLane(lane, async () => {
      blockerStarted.resolve();
      await releaseBlocker.promise;
    });
    await blockerStarted.promise;
    const held = enqueueCommandInLane(
      lane,
      async () => {
        heldExecuted = true;
      },
      { workId: "work-held-cancel" },
    );
    const later = enqueueCommandInLane(lane, async () => "later");
    const hold = acquirePendingCommandAdmissionHoldByWorkId("work-held-cancel");
    expect(hold).toBeDefined();

    releaseBlocker.resolve();
    await blocker;
    expect(heldExecuted).toBe(false);
    expect(hold?.commitCancellation()).toBe(1);
    await expect(held).rejects.toMatchObject({ name: "AbortError" });
    await expect(later).resolves.toBe("later");
    expect(heldExecuted).toBe(false);
    expect(hold?.commitCancellation()).toBe(0);
  });
});
