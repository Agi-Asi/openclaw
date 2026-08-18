import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryBrokerProcess } from "../memory-broker/process.js";
import { startMemoryBrokerSupervisor } from "./memory-broker-supervisor.js";

function process(params: { running?: boolean; healthy?: boolean } = {}): MemoryBrokerProcess {
  return {
    client: {} as MemoryBrokerProcess["client"],
    brokerEpoch: "epoch",
    isRunning: () => params.running ?? true,
    isHealthy: async () => params.healthy ?? true,
    quiesce: async () => {},
    resume: async () => {},
    close: async () => {},
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("memory broker supervisor", () => {
  it("starts ready, retires an unhealthy child, and replaces it with bounded retry", async () => {
    vi.useFakeTimers();
    const ready = process();
    const unhealthy = process({ healthy: false });
    const replacement = process();
    const ensureProcess = vi
      .fn<() => Promise<MemoryBrokerProcess | undefined>>()
      .mockResolvedValueOnce(ready)
      .mockResolvedValueOnce(unhealthy)
      .mockResolvedValueOnce(replacement);
    const retireProcess = vi.fn<() => Promise<void>>().mockResolvedValue();

    const supervisor = await startMemoryBrokerSupervisor({
      ensureProcess,
      retireProcess,
      healthIntervalMs: 10,
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(retireProcess).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ensureProcess).toHaveBeenCalledTimes(3);

    await supervisor.stop();
    expect(retireProcess).toHaveBeenCalledTimes(2);
  });

  it("fails Gateway readiness when the selected broker cannot become healthy", async () => {
    const retireProcess = vi.fn<() => Promise<void>>().mockResolvedValue();
    await expect(
      startMemoryBrokerSupervisor({
        ensureProcess: async () => undefined,
        retireProcess,
      }),
    ).rejects.toThrow("selected memory broker did not become ready");
    expect(retireProcess).toHaveBeenCalledTimes(1);
  });
});
