import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryBrokerProcess } from "../memory-broker/process.js";
import {
  closeBrokeredMemoryRuntimes,
  startBrokeredMemoryRuntimeSupervisor,
  testing,
  withBrokeredMemoryMaintenance,
} from "./memory-broker-runtime.js";
import type { MemoryPluginCapability } from "./registry-contribution-types.js";

const startMemoryBrokerProcess = vi.hoisted(() => vi.fn());

vi.mock("../memory-broker/process.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../memory-broker/process.js")>()),
  startMemoryBrokerProcess,
}));

function process(params: { running?: boolean } = {}) {
  return {
    isRunning: () => params.running ?? true,
    quiesce: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
  };
}

function brokerProcess(): MemoryBrokerProcess {
  return {
    client: {} as MemoryBrokerProcess["client"],
    brokerEpoch: "test-epoch",
    isRunning: () => true,
    isHealthy: async () => true,
    quiesce: async () => {},
    resume: async () => {},
    close: async () => {},
  };
}

const brokerCapability = {
  broker: {
    version: 1,
    kind: "local-child",
    moduleUrl: "test:memory-broker-runtime",
  },
} satisfies MemoryPluginCapability;

afterEach(async () => {
  await closeBrokeredMemoryRuntimes();
  startMemoryBrokerProcess.mockReset();
});

describe("brokered memory maintenance", () => {
  it("drains a running broker before maintenance and resumes it afterwards", async () => {
    const broker = process();
    const run = vi.fn(async () => "snapshot-created");
    const retire = vi.fn(async () => {});

    await expect(
      testing.runBrokeredMemoryMaintenance({ process: broker, run, retire }),
    ).resolves.toBe("snapshot-created");

    expect(broker.quiesce).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
    expect(broker.resume).toHaveBeenCalledOnce();
    expect(retire).not.toHaveBeenCalled();
  });

  it("retires and rejects when quiesce fails before the mutation starts", async () => {
    const broker = process();
    broker.quiesce.mockRejectedValueOnce(new Error("broker unavailable"));
    const run = vi.fn(async () => "unreachable");
    const retire = vi.fn(async () => {});

    await expect(
      testing.runBrokeredMemoryMaintenance({ process: broker, run, retire }),
    ).rejects.toThrow("broker unavailable");

    expect(run).not.toHaveBeenCalled();
    expect(retire).toHaveBeenCalledOnce();
  });

  it("retires and rejects when resume fails after a mutation", async () => {
    const broker = process();
    broker.resume.mockRejectedValueOnce(new Error("broker resume unavailable"));
    const retire = vi.fn(async () => {});

    await expect(
      testing.runBrokeredMemoryMaintenance({
        process: broker,
        run: async () => "snapshot-created",
        retire,
      }),
    ).rejects.toThrow("broker resume unavailable");

    expect(retire).toHaveBeenCalledOnce();
  });

  it("serializes maintenance, process resolution, and shutdown on one broker lease", async () => {
    const leases = new Map<string, Promise<void>>();
    const order: string[] = [];
    let releaseMaintenance: (() => void) | undefined;
    let markMaintenanceStarted: (() => void) | undefined;
    const maintenanceStarted = new Promise<void>((resolve) => {
      markMaintenanceStarted = resolve;
    });
    const maintenanceMayFinish = new Promise<void>((resolve) => {
      releaseMaintenance = resolve;
    });

    const maintenance = testing.withBrokerLease(leases, "memory-core", async () => {
      order.push("maintenance:start");
      markMaintenanceStarted?.();
      await maintenanceMayFinish;
      order.push("maintenance:finish");
    });
    await maintenanceStarted;
    const resolve = testing.withBrokerLease(leases, "memory-core", async () => {
      order.push("resolve");
    });
    const shutdown = testing.withBrokerLease(leases, "memory-core", async () => {
      order.push("shutdown");
    });

    await Promise.resolve();
    expect(order).toEqual(["maintenance:start"]);
    releaseMaintenance?.();
    await Promise.all([maintenance, resolve, shutdown]);
    expect(order).toEqual(["maintenance:start", "maintenance:finish", "resolve", "shutdown"]);
  });

  it("blocks broker resolution while maintenance holds the gateway lease without a running broker", async () => {
    const gate = testing.createBrokerMaintenanceGate();
    const order: string[] = [];
    let releaseMaintenance: (() => void) | undefined;
    let markMaintenanceStarted: (() => void) | undefined;
    const maintenanceStarted = new Promise<void>((resolve) => {
      markMaintenanceStarted = resolve;
    });
    const maintenanceMayFinish = new Promise<void>((resolve) => {
      releaseMaintenance = resolve;
    });

    const maintenance = testing.withGatewayBrokeredMemoryMaintenanceLease(gate, async () => {
      order.push("maintenance:start");
      markMaintenanceStarted?.();
      await maintenanceMayFinish;
      order.push("maintenance:finish");
    });
    await maintenanceStarted;
    const resolution = testing.withBrokerLifecycleOperation(gate, async () => {
      order.push("broker:start");
    });

    await Promise.resolve();
    expect(order).toEqual(["maintenance:start"]);
    releaseMaintenance?.();
    await Promise.all([maintenance, resolution]);
    expect(order).toEqual(["maintenance:start", "maintenance:finish", "broker:start"]);
  });

  it("waits for an admitted broker resolution before maintenance starts", async () => {
    const gate = testing.createBrokerMaintenanceGate();
    const order: string[] = [];
    let releaseResolution: (() => void) | undefined;
    let markResolutionStarted: (() => void) | undefined;
    const resolutionStarted = new Promise<void>((resolve) => {
      markResolutionStarted = resolve;
    });
    const resolutionMayFinish = new Promise<void>((resolve) => {
      releaseResolution = resolve;
    });

    const resolution = testing.withBrokerLifecycleOperation(gate, async () => {
      order.push("broker:start");
      markResolutionStarted?.();
      await resolutionMayFinish;
      order.push("broker:finish");
    });
    await resolutionStarted;
    const maintenance = testing.withGatewayBrokeredMemoryMaintenanceLease(gate, async () => {
      order.push("maintenance");
    });

    await Promise.resolve();
    expect(order).toEqual(["broker:start"]);
    releaseResolution?.();
    await Promise.all([resolution, maintenance]);
    expect(order).toEqual(["broker:start", "broker:finish", "maintenance"]);
  });

  it("does not start a broker requested after empty-map maintenance begins", async () => {
    const broker = brokerProcess();
    startMemoryBrokerProcess.mockResolvedValueOnce(broker);
    let releaseMaintenance: (() => void) | undefined;
    let markMaintenanceStarted: (() => void) | undefined;
    const maintenanceStarted = new Promise<void>((resolve) => {
      markMaintenanceStarted = resolve;
    });
    const maintenanceMayFinish = new Promise<void>((resolve) => {
      releaseMaintenance = resolve;
    });

    const maintenance = withBrokeredMemoryMaintenance(async () => {
      markMaintenanceStarted?.();
      await maintenanceMayFinish;
    });
    await maintenanceStarted;
    const supervisor = startBrokeredMemoryRuntimeSupervisor(brokerCapability);

    await Promise.resolve();
    expect(startMemoryBrokerProcess).not.toHaveBeenCalled();
    releaseMaintenance?.();
    await Promise.all([maintenance, supervisor]);
    expect(startMemoryBrokerProcess).toHaveBeenCalledOnce();

    // Regression: shutdown stops supervisors before taking the writer lease, so stop's reader
    // retirement cannot deadlock behind the writer that is waiting for it.
    await expect(closeBrokeredMemoryRuntimes()).resolves.toBeUndefined();
  });

  it("drains an admitted broker start before maintenance snapshots processes", async () => {
    const broker = brokerProcess();
    let resolveStart: ((value: MemoryBrokerProcess) => void) | undefined;
    let markStartCalled: (() => void) | undefined;
    const startCalled = new Promise<void>((resolve) => {
      markStartCalled = resolve;
    });
    const pendingStart = new Promise<MemoryBrokerProcess>((resolve) => {
      resolveStart = resolve;
    });
    startMemoryBrokerProcess.mockImplementationOnce(() => {
      markStartCalled?.();
      return pendingStart;
    });
    const supervisor = startBrokeredMemoryRuntimeSupervisor(brokerCapability);
    await startCalled;
    const run = vi.fn(async () => {});
    const maintenance = withBrokeredMemoryMaintenance(run);

    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
    resolveStart?.(broker);
    await Promise.all([supervisor, maintenance]);
    expect(run).toHaveBeenCalledOnce();
  });
});
