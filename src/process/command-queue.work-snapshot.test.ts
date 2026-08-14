import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  enqueueCommandInLane,
  getCommandQueueWorkProjection,
  getCommandQueueWorkSnapshot,
  setCommandLaneConcurrency,
} from "./command-queue.js";
import { resetCommandQueueStateForTest } from "./command-queue.test-support.js";
import { getCommandQueueWorkProjectionBuildCountForTest } from "./command-queue.work-snapshot.js";
import { CommandLane } from "./lanes.js";

describe("command queue work snapshots", () => {
  beforeEach(() => {
    resetCommandQueueStateForTest();
    setCommandLaneConcurrency(CommandLane.Main, 1);
  });

  it("reports current queue position after a later priority insertion", async () => {
    const blocker = createDeferred();
    const active = enqueueCommandInLane(
      CommandLane.Main,
      async () => {
        await blocker.promise;
      },
      { workId: "run-active" },
    );
    const background = enqueueCommandInLane(CommandLane.Main, async () => {}, {
      workId: "run-background",
      priority: "background",
    });
    const foreground = enqueueCommandInLane(CommandLane.Main, async () => {}, {
      workId: "run-foreground",
      priority: "foreground",
    });

    expect(getCommandQueueWorkSnapshot().get("run-background")).toMatchObject({
      queuedAhead: 1,
      queuedAheadWorkIds: ["run-foreground"],
    });
    expect(getCommandQueueWorkSnapshot().get("run-foreground")).toMatchObject({
      queuedAhead: 0,
      queuedAheadWorkIds: [],
    });

    blocker.resolve();
    await Promise.all([active, foreground, background]);
  });

  it("counts anonymous active slots without inventing blocker identities", async () => {
    setCommandLaneConcurrency(CommandLane.Main, 4);
    const blockers = Array.from({ length: 4 }, () => createDeferred());
    const active = blockers.map((blocker, index) =>
      enqueueCommandInLane(
        CommandLane.Main,
        async () => {
          await blocker.promise;
        },
        index === 0 ? undefined : { workId: `run-active-${index}` },
      ),
    );
    const queued = enqueueCommandInLane(CommandLane.Main, async () => {}, {
      workId: "run-queued",
    });

    expect(getCommandQueueWorkSnapshot().get("run-queued")).toMatchObject({
      busySlots: 4,
      capacity: 4,
      activeWorkIds: ["run-active-1", "run-active-2", "run-active-3"],
    });

    for (const blocker of blockers) {
      blocker.resolve();
    }
    await Promise.all([...active, queued]);
  });

  it("reuses a work snapshot until queue state changes", async () => {
    const blocker = createDeferred();
    const active = enqueueCommandInLane(CommandLane.Main, async () => {
      await blocker.promise;
    });
    const first = enqueueCommandInLane(CommandLane.Main, async () => {}, {
      workId: "run-first",
    });

    const initial = getCommandQueueWorkSnapshot();
    expect(getCommandQueueWorkSnapshot()).toBe(initial);

    const second = enqueueCommandInLane(CommandLane.Main, async () => {}, {
      workId: "run-second",
    });
    const updated = getCommandQueueWorkSnapshot();
    expect(updated).not.toBe(initial);
    expect(initial.has("run-second")).toBe(false);
    expect(updated.get("run-second")).toMatchObject({ queuedAhead: 1 });
    expect(getCommandQueueWorkSnapshot()).toBe(updated);

    blocker.resolve();
    await Promise.all([active, first, second]);
  });

  it("reuses one work projection across a queue-state callback batch", async () => {
    const blocker = createDeferred();
    const active = enqueueCommandInLane(CommandLane.Main, async () => {
      await blocker.promise;
    });
    const observedProjections: ReturnType<typeof getCommandQueueWorkProjection>[] = [];
    const queued = Array.from({ length: 3 }, (_, index) =>
      enqueueCommandInLane(CommandLane.Main, async () => {}, {
        workId: `run-queued-${index}`,
        onQueueStateChange: () => observedProjections.push(getCommandQueueWorkProjection()),
      }),
    );

    await vi.waitFor(() => expect(observedProjections).toHaveLength(3));
    expect(observedProjections[1]).toBe(observedProjections[0]);
    expect(observedProjections[2]).toBe(observedProjections[0]);

    const next = enqueueCommandInLane(CommandLane.Main, async () => {}, {
      workId: "run-next-transition",
    });
    expect(getCommandQueueWorkProjection()).not.toBe(observedProjections[0]);

    blocker.resolve();
    await Promise.all([active, ...queued, next]);
  });

  it("does not rebroadcast unchanged waits when 500 tasks append at the tail", async () => {
    const blocker = createDeferred();
    const active = enqueueCommandInLane(CommandLane.Main, async () => {
      await blocker.promise;
    });
    const callbackCounts = Array.from({ length: 500 }, () => 0);
    const queued: Array<Promise<void>> = [];
    let firstRevision: number | undefined;

    try {
      for (let index = 0; index < callbackCounts.length; index += 1) {
        queued.push(
          enqueueCommandInLane(CommandLane.Main, async () => {}, {
            workId: `run-tail-${index}`,
            onQueueStateChange: () => {
              callbackCounts[index] = (callbackCounts[index] ?? 0) + 1;
            },
          }),
        );
        await Promise.resolve();
        if (index === 0) {
          firstRevision = getCommandQueueWorkProjection().revisionByWorkId.get("run-tail-0");
        }
      }

      expect(callbackCounts.every((count) => count === 1)).toBe(true);
      expect(getCommandQueueWorkProjection().revisionByWorkId.get("run-tail-0")).toBe(
        firstRevision,
      );
    } finally {
      blocker.resolve();
      await Promise.all([active, ...queued]);
    }
  });

  it("rebuilds one projection for a synchronous burst of 500 tail appends", async () => {
    const blocker = createDeferred();
    const active = enqueueCommandInLane(CommandLane.Main, async () => {
      await blocker.promise;
    });
    let firstCallbackCount = 0;
    const first = enqueueCommandInLane(CommandLane.Main, async () => {}, {
      workId: "run-burst-first",
      onQueueStateChange: () => {
        firstCallbackCount += 1;
      },
    });
    await Promise.resolve();
    const firstRevision = getCommandQueueWorkProjection().revisionByWorkId.get("run-burst-first");
    const buildsBefore = getCommandQueueWorkProjectionBuildCountForTest();
    const queued: Array<Promise<void>> = [];

    try {
      for (let index = 0; index < 500; index += 1) {
        queued.push(
          enqueueCommandInLane(CommandLane.Main, async () => {}, {
            workId: `run-burst-tail-${index}`,
          }),
        );
      }

      expect(getCommandQueueWorkProjectionBuildCountForTest()).toBe(buildsBefore);
      await Promise.resolve();
      expect(getCommandQueueWorkProjectionBuildCountForTest()).toBe(buildsBefore + 1);
      expect(firstCallbackCount).toBe(1);
      expect(getCommandQueueWorkProjection().revisionByWorkId.get("run-burst-first")).toBe(
        firstRevision,
      );
    } finally {
      blocker.resolve();
      await Promise.all([active, first, ...queued]);
    }
  });

  it("scopes revisions to a new epoch across queue runtime resets", async () => {
    resetCommandQueueStateForTest();
    setCommandLaneConcurrency(CommandLane.Main, 1);
    const firstGate = createDeferred();
    const first = enqueueCommandInLane(CommandLane.Main, async () => await firstGate.promise, {
      workId: "run-first-process",
    });
    const firstProjection = getCommandQueueWorkProjection();

    firstGate.resolve();
    await first;
    resetCommandQueueStateForTest();
    setCommandLaneConcurrency(CommandLane.Main, 1);
    const secondGate = createDeferred();
    const second = enqueueCommandInLane(CommandLane.Main, async () => await secondGate.promise, {
      workId: "run-second-process",
    });
    const secondProjection = getCommandQueueWorkProjection();

    expect(firstProjection.revisionByWorkId.get("run-first-process")).toEqual(expect.any(Number));
    expect(secondProjection.revisionByWorkId.get("run-second-process")).toEqual(expect.any(Number));
    expect(secondProjection.epoch).not.toBe(firstProjection.epoch);
    secondGate.resolve();
    await second;
  });
});
