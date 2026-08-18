import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createChannelIngressDrain } from "./ingress-drain.js";
import {
  createTestIngressQueue,
  type IngressDrainTestPayload as Payload,
  withTempState,
} from "./ingress-drain.test-helpers.js";

describe("channel ingress drain watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    closeOpenClawStateDatabaseForTest();
  });

  it("guillotines pre-adoption stalls with handler-timeout", async () => {
    await withTempState(async (stateDir) => {
      let clock = 10_000;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue("evt-stall", { text: "x" }, { laneKey: "l1" });

      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        adoptionStallTimeoutMs: 5_000,
        dispatchClaimedEvent: async () => {
          // Never adopt, never return -- stall until watchdog.
          await new Promise(() => {});
        },
      });

      await drain.drainOnce();
      clock += 5_000;
      await vi.advanceTimersByTimeAsync(5_000);
      await drain.waitForIdle();

      const reenqueue = await queue.enqueue("evt-stall", { text: "x" });
      expect(reenqueue.kind).toBe("failed");
      if (reenqueue.kind === "failed") {
        expect(reenqueue.record.reason).toBe("handler-timeout");
      }
      drain.dispose();
    });
  });

  it("lets lifecycle-owned deferrals outlive the pre-adoption watchdog", async () => {
    await withTempState(async (stateDir) => {
      let clock = 30_000;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue("evt-def-stall", { text: "x" }, { laneKey: "l1" });
      let adoptDeferred: (() => void | Promise<void>) | undefined;

      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        adoptionStallTimeoutMs: 5_000,
        dispatchClaimedEvent: async (_event, lifecycle) => {
          adoptDeferred = lifecycle.onAdopted;
          lifecycle.onDeferred();
          return { kind: "deferred" };
        },
      });

      await drain.drainOnce();
      expect(await queue.listClaims()).toHaveLength(1);
      clock += 60_000;
      await vi.advanceTimersByTimeAsync(60_000);

      expect(await queue.listFailed?.()).toEqual([]);
      expect((await queue.listClaims()).map((claim) => claim.id)).toEqual(["evt-def-stall"]);

      await adoptDeferred?.();
      await drain.waitForIdle();
      await expect(queue.enqueue("evt-def-stall", { text: "x" })).resolves.toMatchObject({
        kind: "completed",
      });
      drain.dispose();
    });
  });

  it("guillotines deferred work when queue ownership stops reporting progress", async () => {
    await withTempState(async (stateDir) => {
      let clock = 40_000;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue("evt-def-orphan", { text: "x" }, { laneKey: "l1" });

      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        adoptionStallTimeoutMs: 5_000,
        dispatchClaimedEvent: async (_event, lifecycle) => {
          lifecycle.onDeferred();
          return { kind: "deferred" };
        },
      });

      try {
        await drain.drainOnce();
        clock += 5_000;
        await vi.advanceTimersByTimeAsync(5_000);

        expect(await queue.listFailed?.()).toEqual([
          expect.objectContaining({ id: "evt-def-orphan", reason: "handler-timeout" }),
        ]);
      } finally {
        drain.dispose();
      }
    });
  });

  it("does not kill healthy long turns after adoption", async () => {
    await withTempState(async (stateDir) => {
      let clock = 20_000;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue("evt-long", { text: "x" }, { laneKey: "l1" });

      let settleResolve!: () => void;
      const settleGate = new Promise<void>((resolve) => {
        settleResolve = resolve;
      });

      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        adoptionStallTimeoutMs: 1_000,
        dispatchClaimedEvent: async (_event, lifecycle) => {
          await lifecycle.onAdopted();
          await settleGate;
        },
      });

      await drain.drainOnce();
      await vi.waitFor(async () => {
        expect(await queue.listClaims()).toEqual([]);
      });
      clock += 60_000;
      await vi.advanceTimersByTimeAsync(60_000);
      const status = await queue.enqueue("evt-long", { text: "x" });
      expect(status.kind).toBe("completed");
      settleResolve();
      await drain.waitForIdle();
      drain.dispose();
    });
  });
});
