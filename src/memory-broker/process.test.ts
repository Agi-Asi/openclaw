import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { startMemoryBrokerProcess, type MemoryBrokerProcess } from "./process.js";
import type { MemoryBrokerAuthorizationBinding } from "./protocol.js";

let broker: MemoryBrokerProcess | undefined;

afterEach(async () => {
  await broker?.close();
  broker = undefined;
});

async function waitForBrokerSocket(existingDirectories: ReadonlySet<string>): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const names = await readdir(tmpdir());
    const directory = names.find(
      (name) => name.startsWith("openclaw-memory-broker-") && !existingDirectories.has(name),
    );
    if (directory) {
      return path.join(tmpdir(), directory, "broker.sock");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("memory broker test socket did not appear");
}

async function runMaliciousClient(params: {
  socketPath: string;
  brokerEpoch: string;
}): Promise<string> {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./test-malicious-client.mjs", import.meta.url))],
    {
      env: {
        OPENCLAW_MEMORY_BROKER_TEST_SOCKET: params.socketPath,
        OPENCLAW_MEMORY_BROKER_TEST_EPOCH: params.brokerEpoch,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const output: Buffer[] = [];
  const errors: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  if (code !== 0) {
    throw new Error(`malicious broker client failed: ${Buffer.concat(errors).toString("utf8")}`);
  }
  return Buffer.concat(output).toString("utf8");
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

describe("memory broker child", () => {
  it("loads only the selected entry over parent-child IPC and serves a signed request", async () => {
    broker = await startMemoryBrokerProcess({
      brokerId: "broker-a",
      childModuleUrl: new URL("./child.ts", import.meta.url),
      handlerModuleUrl: new URL("./test-handler.mjs", import.meta.url).href,
    });
    await expect(
      broker.client.request({
        binding: {
          agentId: "agent-a",
          sessionId: "session-a",
          runId: "run-a",
          contextFingerprint: "context-a",
          subjectRevision: "subject-a",
          actor: { kind: "principal", actorKind: "human", principalId: "alice" },
          actorRevision: "actor-a",
          capabilitySnapshotId: "capability-a",
          policyRevision: "policy-a",
          deliveryRevision: "delivery-a",
        },
        method: "memory.search",
        payload: { query: "Alice" },
        expiresAtMs: Date.now() + 30_000,
      }),
    ).resolves.toEqual({ agentId: "agent-a", method: "memory.search" });
  });

  it("runs selected-runtime startup recovery with sorted configured agents before serving", async () => {
    broker = await startMemoryBrokerProcess({
      brokerId: "broker-a",
      childModuleUrl: new URL("./child.ts", import.meta.url),
      handlerModuleUrl: new URL("./test-handler.mjs", import.meta.url).href,
      agentIds: ["work", "main", "work"],
    });

    await expect(
      broker.client.request({
        binding: {
          agentId: "main",
          sessionId: "session-a",
          runId: "run-a",
          contextFingerprint: "context-a",
          subjectRevision: "subject-a",
          actor: { kind: "principal", actorKind: "human", principalId: "alice" },
          actorRevision: "actor-a",
          capabilitySnapshotId: "capability-a",
          policyRevision: "policy-a",
          deliveryRevision: "delivery-a",
        },
        method: "memory.startup",
        payload: {},
        expiresAtMs: Date.now() + 30_000,
      }),
    ).resolves.toEqual({ agentIds: ["main", "work"] });
  });

  it("does not report ready when selected-runtime startup recovery fails", async () => {
    await expect(
      startMemoryBrokerProcess({
        brokerId: "broker-a",
        childModuleUrl: new URL("./child.ts", import.meta.url),
        handlerModuleUrl: new URL("./test-handler.mjs", import.meta.url).href,
        agentIds: ["fail-startup"],
      }),
    ).rejects.toThrow("memory broker child did not become ready");
  });

  it("retires a stopped child and gives its replacement a new broker epoch", async () => {
    broker = await startMemoryBrokerProcess({
      brokerId: "broker-a",
      childModuleUrl: new URL("./child.ts", import.meta.url),
      handlerModuleUrl: new URL("./test-handler.mjs", import.meta.url).href,
    });
    const firstEpoch = broker.brokerEpoch;
    expect(broker.isRunning()).toBe(true);
    await expect(broker.isHealthy()).resolves.toBe(true);
    await broker.close();
    expect(broker.isRunning()).toBe(false);
    await expect(broker.isHealthy()).resolves.toBe(false);

    broker = await startMemoryBrokerProcess({
      brokerId: "broker-a",
      childModuleUrl: new URL("./child.ts", import.meta.url),
      handlerModuleUrl: new URL("./test-handler.mjs", import.meta.url).href,
    });
    expect(broker.isRunning()).toBe(true);
    await expect(broker.isHealthy()).resolves.toBe(true);
    expect(broker.brokerEpoch).not.toBe(firstEpoch);
  });

  it("retires an unexpectedly crashed child and requires a fresh broker epoch", async () => {
    broker = await startMemoryBrokerProcess({
      brokerId: "broker-a",
      childModuleUrl: new URL("./child.ts", import.meta.url),
      handlerModuleUrl: new URL("./test-handler.mjs", import.meta.url).href,
    });
    const crashedBroker = broker;
    const firstEpoch = crashedBroker.brokerEpoch;
    const binding: MemoryBrokerAuthorizationBinding = {
      agentId: "agent-a",
      sessionId: "session-a",
      runId: "run-a",
      contextFingerprint: "context-a",
      subjectRevision: "subject-a",
      actor: { kind: "principal", actorKind: "human", principalId: "alice" },
      actorRevision: "actor-a",
      capabilitySnapshotId: "capability-a",
      policyRevision: "policy-a",
      deliveryRevision: "delivery-a",
    };

    await expect(
      crashedBroker.client.request({
        binding,
        method: "memory.crash",
        payload: {},
        expiresAtMs: Date.now() + 30_000,
      }),
    ).resolves.toBeUndefined();
    await waitFor(() => !crashedBroker.isRunning(), "memory broker child did not exit after crash");
    await expect(crashedBroker.isHealthy()).resolves.toBe(false);

    broker = await startMemoryBrokerProcess({
      brokerId: "broker-a",
      childModuleUrl: new URL("./child.ts", import.meta.url),
      handlerModuleUrl: new URL("./test-handler.mjs", import.meta.url).href,
    });
    expect(broker.brokerEpoch).not.toBe(firstEpoch);
    await expect(
      broker.client.request({
        binding,
        method: "memory.search",
        payload: { query: "Alice" },
        expiresAtMs: Date.now() + 30_000,
      }),
    ).resolves.toEqual({ agentId: "agent-a", method: "memory.search" });
  });

  it("retires a child killed by an external signal without waiting for a second exit event", async () => {
    broker = await startMemoryBrokerProcess({
      brokerId: "broker-a",
      childModuleUrl: new URL("./child.ts", import.meta.url),
      handlerModuleUrl: new URL("./test-handler.mjs", import.meta.url).href,
    });
    const killedBroker = broker;
    await expect(
      killedBroker.client.request({
        binding: {
          agentId: "agent-a",
          sessionId: "session-a",
          runId: "run-a",
          contextFingerprint: "context-a",
          subjectRevision: "subject-a",
          actor: { kind: "principal", actorKind: "human", principalId: "alice" },
          actorRevision: "actor-a",
          capabilitySnapshotId: "capability-a",
          policyRevision: "policy-a",
          deliveryRevision: "delivery-a",
        },
        method: "memory.kill",
        payload: {},
        expiresAtMs: Date.now() + 30_000,
      }),
    ).resolves.toBeUndefined();
    await waitFor(() => !killedBroker.isRunning(), "memory broker child did not exit after SIGKILL");

    await expect(killedBroker.close()).resolves.toBeUndefined();
  });

  it("does not inherit arbitrary Gateway environment secrets", async () => {
    const previous = process.env.OPENCLAW_MEMORY_BROKER_TEST_SECRET;
    process.env.OPENCLAW_MEMORY_BROKER_TEST_SECRET = "gateway-only-secret";
    try {
      broker = await startMemoryBrokerProcess({
        brokerId: "broker-a",
        childModuleUrl: new URL("./child.ts", import.meta.url),
        handlerModuleUrl: new URL("./test-handler.mjs", import.meta.url).href,
      });
      await expect(
        broker.client.request({
          binding: {
            agentId: "agent-a",
            sessionId: "session-a",
            runId: "run-a",
            contextFingerprint: "context-a",
            subjectRevision: "subject-a",
            actor: { kind: "principal", actorKind: "human", principalId: "alice" },
            actorRevision: "actor-a",
            capabilitySnapshotId: "capability-a",
            policyRevision: "policy-a",
            deliveryRevision: "delivery-a",
          },
          method: "memory.environment",
          payload: {},
          expiresAtMs: Date.now() + 30_000,
        }),
      ).resolves.toEqual({ parentSecret: "absent" });
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_MEMORY_BROKER_TEST_SECRET;
      } else {
        process.env.OPENCLAW_MEMORY_BROKER_TEST_SECRET = previous;
      }
    }
  });

  it("rejects a forged cross-tenant request from a separate process without giving it a broker credential", async () => {
    const existingDirectories = new Set(
      (await readdir(tmpdir())).filter((name) => name.startsWith("openclaw-memory-broker-")),
    );
    broker = await startMemoryBrokerProcess({
      brokerId: "broker-a",
      childModuleUrl: new URL("./child.ts", import.meta.url),
      handlerModuleUrl: new URL("./test-handler.mjs", import.meta.url).href,
    });
    const socketPath = await waitForBrokerSocket(existingDirectories);
    // The agent namespace never receives this directory, and a sibling host user must not be
    // able to discover a connectable broker endpoint even before frame authentication rejects it.
    expect((await stat(path.dirname(socketPath))).mode & 0o777).toBe(0o700);

    await expect(runMaliciousClient({ socketPath, brokerEpoch: broker.brokerEpoch })).resolves.toBe(
      '{"ok":false,"error":"unauthorized"}\n',
    );
  });

  it("quiesces and resumes through parent-child IPC without exposing a maintenance socket", async () => {
    broker = await startMemoryBrokerProcess({
      brokerId: "broker-a",
      childModuleUrl: new URL("./child.ts", import.meta.url),
      handlerModuleUrl: new URL("./test-handler.mjs", import.meta.url).href,
    });
    await broker.quiesce();
    await expect(
      broker.client.request({
        binding: {
          agentId: "agent-a",
          sessionId: "session-a",
          runId: "run-a",
          contextFingerprint: "context-a",
          subjectRevision: "subject-a",
          actor: { kind: "principal", actorKind: "human", principalId: "alice" },
          actorRevision: "actor-a",
          capabilitySnapshotId: "capability-a",
          policyRevision: "policy-a",
          deliveryRevision: "delivery-a",
        },
        method: "memory.search",
        payload: { query: "Alice" },
        expiresAtMs: Date.now() + 30_000,
      }),
    ).resolves.toBeUndefined();
    await broker.resume();
    await expect(
      broker.client.request({
        binding: {
          agentId: "agent-a",
          sessionId: "session-a",
          runId: "run-a",
          contextFingerprint: "context-a",
          subjectRevision: "subject-a",
          actor: { kind: "principal", actorKind: "human", principalId: "alice" },
          actorRevision: "actor-a",
          capabilitySnapshotId: "capability-a",
          policyRevision: "policy-a",
          deliveryRevision: "delivery-a",
        },
        method: "memory.search",
        payload: { query: "Alice" },
        expiresAtMs: Date.now() + 30_000,
      }),
    ).resolves.toEqual({ agentId: "agent-a", method: "memory.search" });
  });

  it("retires a noncooperative child instead of leaving a healthy broker quiesced", async () => {
    broker = await startMemoryBrokerProcess({
      brokerId: "broker-a",
      childModuleUrl: new URL("./child.ts", import.meta.url),
      handlerModuleUrl: new URL("./test-handler.mjs", import.meta.url).href,
      maintenanceTimeoutMs: 40,
    });
    const pending = broker.client.request({
      binding: {
        agentId: "agent-a",
        sessionId: "session-a",
        runId: "run-a",
        contextFingerprint: "context-a",
        subjectRevision: "subject-a",
        actor: { kind: "principal", actorKind: "human", principalId: "alice" },
        actorRevision: "actor-a",
        capabilitySnapshotId: "capability-a",
        policyRevision: "policy-a",
        deliveryRevision: "delivery-a",
      },
      method: "memory.hang",
      payload: {},
      expiresAtMs: Date.now() + 30_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    await expect(broker.quiesce()).rejects.toThrow("memory broker quiesce is unavailable");
    await expect(pending).resolves.toBeUndefined();
    expect(broker.isRunning()).toBe(false);
    await expect(broker.isHealthy()).resolves.toBe(false);
  });
});
