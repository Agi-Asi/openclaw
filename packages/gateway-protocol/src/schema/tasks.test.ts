import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { NonEmptyString } from "./primitives.js";
import { TaskSummarySchema } from "./tasks.js";

describe("TaskSummarySchema", () => {
  it("accepts bounded live subagent progress and keeps diff stats closed", () => {
    const summary = {
      id: "task-1",
      status: "running",
      lastActivity: "Updating the gateway task ledger",
      diffStat: { files: 3, added: 12, removed: 4 },
    };

    expect(Value.Check(TaskSummarySchema, summary)).toBe(true);
    expect(Value.Check(TaskSummarySchema, { ...summary, lastActivity: "x".repeat(201) })).toBe(
      false,
    );
    expect(
      Value.Check(TaskSummarySchema, {
        ...summary,
        diffStat: { ...summary.diffStat, removed: -1 },
      }),
    ).toBe(false);
    expect(
      Value.Check(TaskSummarySchema, {
        ...summary,
        diffStat: { ...summary.diffStat, unchanged: 8 },
      }),
    ).toBe(false);
  });

  it("accepts bounded queue wait facts and rejects unbounded blocker refs", () => {
    const blocker = { taskId: "task-blocker", title: "Blocking task" };
    const summary = {
      id: "task-waiting",
      status: "queued",
      queueEpoch: "gateway-process-1",
      queueRevision: 4,
      queueWait: {
        since: 1_000,
        queuedAhead: 4,
        busySlots: 3,
        capacity: 3,
        activeBlockers: [blocker],
        aheadBlockers: [blocker, blocker, blocker],
      },
    };

    expect(Value.Check(TaskSummarySchema, summary)).toBe(true);
    expect(Value.Check(TaskSummarySchema, { ...summary, queueEpoch: "" })).toBe(false);
    expect(
      Value.Check(TaskSummarySchema, {
        ...summary,
        queueWait: {
          ...summary.queueWait,
          aheadBlockers: [...summary.queueWait.aheadBlockers, blocker],
        },
      }),
    ).toBe(false);
  });

  it("does not add task field metadata to shared schema primitives", () => {
    expect("x-openclaw-since" in NonEmptyString).toBe(false);
  });
});
