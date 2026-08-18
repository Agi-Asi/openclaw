import { describe, expect, it, vi } from "vitest";
import { testing } from "./memory-broker-runtime.js";

function process(params: { running?: boolean } = {}) {
  return {
    isRunning: () => params.running ?? true,
    quiesce: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
  };
}

describe("brokered memory maintenance", () => {
  it("drains every running broker before a backup and resumes them afterwards", async () => {
    const first = process();
    const second = process();
    const stopped = process({ running: false });
    const run = vi.fn(async () => "snapshot-created");

    await expect(
      testing.runBrokeredMemoryMaintenance({ processes: [first, second, stopped], run }),
    ).resolves.toBe("snapshot-created");

    expect(first.quiesce).toHaveBeenCalledOnce();
    expect(second.quiesce).toHaveBeenCalledOnce();
    expect(stopped.quiesce).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledOnce();
    expect(first.resume).toHaveBeenCalledOnce();
    expect(second.resume).toHaveBeenCalledOnce();
  });

  it("reopens an already-drained broker when a later broker or the backup fails", async () => {
    const first = process();
    const second = process();
    second.quiesce.mockRejectedValueOnce(new Error("broker unavailable"));
    const run = vi.fn(async () => "unreachable");

    await expect(
      testing.runBrokeredMemoryMaintenance({ processes: [first, second], run }),
    ).rejects.toThrow("broker unavailable");

    expect(run).not.toHaveBeenCalled();
    expect(first.resume).toHaveBeenCalledOnce();
    expect(second.resume).not.toHaveBeenCalled();
  });
});
