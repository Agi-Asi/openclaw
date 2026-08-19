import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { NODE_WORKER_CAPACITY_EXHAUSTED_ERROR_CODE } from "../infra/node-commands.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { NodeWorkerLaunchStore } from "./node-worker-launch-store.js";
import {
  inspectNodeWorkerProcessIdentity,
  requireNodeWorkerProcessIdentity,
} from "./node-worker-process-identity.js";
import { createNodeWorkerSupervisor } from "./node-worker-supervisor.js";
import { NodeWorkerMemoryProjectionRuntime } from "./node-worker-memory-projection.js";
import {
  TEST_WORKER_CREDENTIAL,
  TEST_WORKER_ENDPOINT,
  TEST_WORKER_SOURCE,
  testNodeWorkerMemoryProjection,
  testNodeWorkerLaunchIdentity,
  testWorkerDescriptor,
  testWorkerLaunchInput,
  writeNodeWorkerFixture,
} from "./node-worker-supervisor.test-support.js";

type NodeWorkerSupervisor = ReturnType<typeof createNodeWorkerSupervisor>;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  resetSecretRedactionRegistryForTest();
  closeOpenClawStateDatabaseForTest();
});

function fixture(
  options: {
    capacity?: number;
    capacityWaitMs?: number;
    onCapacityChanged?: (capacity: { total: number; available: number }) => void;
  } = {},
) {
  const root = tempDirs.make("node-worker-supervisor-");
  const { bundleRoot, env, stateDir, workspaceDir } = writeNodeWorkerFixture(root);
  const supervisor = createNodeWorkerSupervisor({ bundleRoot, env, ...options });
  return { bundleRoot, env, root, stateDir, supervisor, workspaceDir };
}

function launchInput(workspaceDir: string, launchId: string, prompt = "success") {
  return testWorkerLaunchInput(workspaceDir, launchId, prompt);
}

async function waitForTerminal(supervisor: NodeWorkerSupervisor, launchId: string) {
  await vi.waitFor(
    async () => {
      expect((await supervisor.status(launchId))?.state).not.toMatch(/^(?:pending|running)$/u);
    },
    { timeout: 5_000 },
  );
  const receipt = await supervisor.status(launchId);
  if (!receipt) {
    throw new Error(`missing launch receipt ${launchId}`);
  }
  return receipt;
}

describe("node worker supervisor", () => {
  it("rejects an enforced-memory host launch before claiming a worker slot", async () => {
    const { env, supervisor, workspaceDir } = fixture();
    const input = launchInput(workspaceDir, "enforced-memory-host-downgrade");
    input.descriptor.assignment.memoryReadEnforced = true;

    await expect(supervisor.launch(input, TEST_WORKER_ENDPOINT)).rejects.toThrow(
      "requires container-v1 execution",
    );
    expect(new NodeWorkerLaunchStore({ env }).get(input.launchId)).toBeUndefined();
    await supervisor.close();
  });

  it("rejects a cross-session memory projection replay before claiming a worker slot", async () => {
    const { env, supervisor, workspaceDir } = fixture();
    const input = launchInput(workspaceDir, "enforced-memory-cross-session-replay");
    input.execution = { kind: "container-v1" };
    input.descriptor.assignment.memoryReadEnforced = true;
    input.descriptor.assignment.workspaceDir = "/workspace";
    input.memoryProjection = testNodeWorkerMemoryProjection(input);
    const replay = structuredClone(input);
    replay.descriptor.admission.sessionId = "another-session";

    await expect(supervisor.launch(replay, TEST_WORKER_ENDPOINT)).rejects.toThrow(
      "memory projection does not match its worker launch",
    );
    expect(new NodeWorkerLaunchStore({ env }).get(replay.launchId)).toBeUndefined();
    await supervisor.close();
  });

  it.runIf(process.platform !== "win32")(
    "persists cancellation and cleans the staged projection before a container can spawn",
    async () => {
      const { bundleRoot, env, root, workspaceDir } = fixture();
      const bin = path.join(root, "bin");
      const commandLog = path.join(root, "docker-commands.log");
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(
        path.join(bin, "docker"),
        `#!/bin/sh\nprintf '%s\\n' "$1" >> ${JSON.stringify(commandLog)}\nif [ "$1" = info ]; then printf 'test-engine'; fi\nexit 0\n`,
        { mode: 0o755 },
      );
      vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
      try {
        const controller = new AbortController();
        const projection = {
          stage: vi.fn(async () => {
            controller.abort(new Error("Gateway revoked the projection"));
            return path.join(root, "staged-projection");
          }),
          remove: vi.fn(async () => undefined),
        } as unknown as NodeWorkerMemoryProjectionRuntime;
        const supervisor = createNodeWorkerSupervisor({ bundleRoot, env, memoryProjection: projection });
        const input = launchInput(workspaceDir, "cancelled-before-container-start");
        input.execution = { kind: "container-v1" };
        input.descriptor.assignment.memoryReadEnforced = true;
        input.descriptor.assignment.workspaceDir = "/workspace";
        input.memoryProjection = testNodeWorkerMemoryProjection(input);

        await expect(supervisor.launch(input, TEST_WORKER_ENDPOINT, controller.signal)).resolves.toMatchObject({
          state: "cancelled",
          errorText: "node worker launch cancelled before process start",
        });
        expect(projection.stage).toHaveBeenCalledOnce();
        expect(projection.remove).toHaveBeenCalledWith({
          gatewayNamespace: input.gatewayNamespace,
          launchId: input.launchId,
          planHash: testNodeWorkerLaunchIdentity(input).planHash,
        });
        expect(fs.readFileSync(commandLog, "utf8").split("\n")).not.toContain("run");
        expect(new NodeWorkerLaunchStore({ env }).get(input.launchId)).toMatchObject({
          state: "cancelled",
        });
        await supervisor.close();
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("keeps construction and close inert without resolving process identity", async () => {
    const root = tempDirs.make("node-worker-inert-");
    const { bundleRoot, env } = writeNodeWorkerFixture(root);
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    const spawnSync = vi.spyOn(childProcess, "spawnSync");
    const execFileSync = vi.spyOn(childProcess, "execFileSync");
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    try {
      const supervisor = createNodeWorkerSupervisor({ bundleRoot, env });
      await supervisor.close();
      expect(spawnSync).not.toHaveBeenCalled();
      expect(execFileSync).not.toHaveBeenCalled();
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
    }
  });

  it("keeps the additive table absent until the first stateful operation", async () => {
    const { bundleRoot, env, supervisor } = fixture();
    const database = openOpenClawStateDatabase({ env });
    const findTable = () =>
      database.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("node_worker_launches");

    expect(findTable()).toBeUndefined();
    await supervisor.close();
    expect(findTable()).toBeUndefined();

    const active = createNodeWorkerSupervisor({ bundleRoot, env });
    expect(await active.status("missing-launch")).toBeUndefined();
    expect(
      database.db
        .prepare("SELECT strict FROM pragma_table_list WHERE name = ?")
        .get("node_worker_launches"),
    ).toEqual({ strict: 1 });
    await active.close();
  });

  it("keeps pending and running launches owned by a live supervisor unchanged", async () => {
    const { bundleRoot, env, supervisor } = fixture();
    await supervisor.status("schema-probe");
    const database = openOpenClawStateDatabase({ env }).db;
    const supervisorIdentity = requireNodeWorkerProcessIdentity(process.pid);
    const insert = database.prepare(`
      INSERT INTO node_worker_launches (
        launch_id, plan_hash, gateway_namespace, environment_id, session_id,
        owner_epoch, placement_generation, run_id, state,
        supervisor_pid, supervisor_start_time, worker_pid, worker_start_time,
        result_json, error_text, completed_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, 'gateway-1', 'environment-1', 'session-1', 3, 4, 'run-1', ?, ?, ?, ?, ?, NULL, NULL, NULL, 1, 1)
    `);
    insert.run(
      "pending-launch",
      "b".repeat(64),
      "pending",
      supervisorIdentity.pid,
      supervisorIdentity.startTime,
      null,
      null,
    );
    insert.run(
      "running-launch",
      "c".repeat(64),
      "running",
      supervisorIdentity.pid,
      supervisorIdentity.startTime,
      process.pid,
      supervisorIdentity.startTime,
    );

    const capacitySnapshots: Array<{ total: number; available: number }> = [];
    const sameHandle = createNodeWorkerSupervisor({
      bundleRoot,
      env,
      capacity: 2,
      onCapacityChanged: (capacity) => capacitySnapshots.push(capacity),
    });
    expect(await sameHandle.status("pending-launch")).toMatchObject({
      state: "pending",
      worker: null,
    });
    expect(await sameHandle.status("running-launch")).toMatchObject({
      state: "running",
      worker: supervisorIdentity,
    });
    expect(capacitySnapshots).toEqual([
      { total: 2, available: 0 },
      { total: 2, available: 0 },
    ]);
    await supervisor.close();
    await sameHandle.close();
    closeOpenClawStateDatabaseForTest();

    openOpenClawStateDatabase({ env });
    const recovered = createNodeWorkerSupervisor({ bundleRoot, env });
    expect(await recovered.status("pending-launch")).toMatchObject({
      state: "pending",
      worker: null,
    });
    expect(await recovered.status("running-launch")).toMatchObject({
      state: "running",
      worker: supervisorIdentity,
    });
    await recovered.close();
  });

  it("launches idempotently and persists only bounded non-secret facts", async () => {
    const { env, supervisor, workspaceDir } = fixture();
    const input = launchInput(workspaceDir, "success-launch");

    expect(await supervisor.launch(input, TEST_WORKER_ENDPOINT)).toMatchObject({
      launchId: "success-launch",
      state: "running",
      environmentId: "environment-1",
      sessionId: "session-1",
      ownerEpoch: 3,
      placementGeneration: 4,
      runId: "run-1",
    });
    const completed = await waitForTerminal(supervisor, input.launchId);
    expect(completed).toMatchObject({ state: "completed", errorText: null });
    expect(JSON.parse(completed.resultJson ?? "null")).toEqual({
      argv: ["--internal-worker-ipc"],
      status: "completed",
    });
    expect(await supervisor.launch(input, TEST_WORKER_ENDPOINT)).toEqual(completed);
    await expect(
      supervisor.launch(
        {
          ...input,
          descriptor: testWorkerDescriptor(workspaceDir, "different-plan"),
        },
        TEST_WORKER_ENDPOINT,
      ),
    ).rejects.toThrow("replayed with a different plan");

    const row = openOpenClawStateDatabase({ env })
      .db.prepare("SELECT * FROM node_worker_launches WHERE launch_id = ?")
      .get(input.launchId);
    expect(JSON.stringify(row)).not.toContain(TEST_WORKER_CREDENTIAL);
    await supervisor.close();
  });

  it("admits two durable launches and releases one physical slot at a time", async () => {
    const capacitySnapshots: Array<{ total: number; available: number }> = [];
    const { env, supervisor, workspaceDir } = fixture({
      capacity: 2,
      capacityWaitMs: 5_000,
      onCapacityChanged: (capacity) => capacitySnapshots.push(capacity),
    });
    const first = launchInput(workspaceDir, "capacity-a", "wait");
    const second = launchInput(workspaceDir, "capacity-b", "wait");
    const third = launchInput(workspaceDir, "capacity-c", "wait");
    const fourth = launchInput(workspaceDir, "capacity-d", "wait");
    const store = new NodeWorkerLaunchStore({ env });

    await supervisor.launch(first, TEST_WORKER_ENDPOINT);
    await supervisor.launch(second, TEST_WORKER_ENDPOINT);
    await expect(supervisor.launch(first, TEST_WORKER_ENDPOINT)).resolves.toMatchObject({
      launchId: first.launchId,
      state: "running",
    });
    expect(capacitySnapshots).toEqual([
      { total: 2, available: 0 },
      { total: 2, available: 2 },
      { total: 2, available: 1 },
      { total: 2, available: 0 },
    ]);

    const thirdAdmission = supervisor.launch(third, TEST_WORKER_ENDPOINT);
    const fourthAdmission = supervisor.launch(fourth, TEST_WORKER_ENDPOINT);
    await vi.waitFor(() => {
      expect(store.get(third.launchId)).toBeUndefined();
      expect(store.get(fourth.launchId)).toBeUndefined();
    });

    await supervisor.cancel(testNodeWorkerLaunchIdentity(first));
    await vi.waitFor(() => {
      expect([third, fourth].filter((input) => store.get(input.launchId))).toHaveLength(1);
    });
    const thirdAdmittedFirst = Boolean(store.get(third.launchId));
    await expect(thirdAdmittedFirst ? thirdAdmission : fourthAdmission).resolves.toMatchObject({
      state: "running",
    });
    expect(store.get(thirdAdmittedFirst ? fourth.launchId : third.launchId)).toBeUndefined();

    await supervisor.cancel(testNodeWorkerLaunchIdentity(second));
    await expect(thirdAdmittedFirst ? fourthAdmission : thirdAdmission).resolves.toMatchObject({
      state: "running",
    });
    expect(capacitySnapshots).toEqual([
      { total: 2, available: 0 },
      { total: 2, available: 2 },
      { total: 2, available: 1 },
      { total: 2, available: 0 },
      { total: 2, available: 1 },
      { total: 2, available: 0 },
      { total: 2, available: 1 },
      { total: 2, available: 0 },
    ]);

    await supervisor.close();
  });

  it("times out saturated admission without creating a launch row", async () => {
    const { env, supervisor, workspaceDir } = fixture({ capacity: 1, capacityWaitMs: 25 });
    const running = launchInput(workspaceDir, "capacity-running", "wait");
    const rejected = launchInput(workspaceDir, "capacity-rejected", "wait");
    await supervisor.launch(running, TEST_WORKER_ENDPOINT);

    await expect(supervisor.launch(rejected, TEST_WORKER_ENDPOINT)).rejects.toMatchObject({
      name: "NodeWorkerCapacityExhaustedError",
      code: NODE_WORKER_CAPACITY_EXHAUSTED_ERROR_CODE,
      message: "node worker capacity remained full for 25 ms",
    });
    expect(new NodeWorkerLaunchStore({ env }).get(rejected.launchId)).toBeUndefined();
    await supervisor.close();
  });

  it("abandons saturated admission when its invocation is cancelled", async () => {
    const { env, supervisor, workspaceDir } = fixture({ capacity: 1, capacityWaitMs: 5_000 });
    const running = launchInput(workspaceDir, "capacity-abort-running", "wait");
    const waiting = launchInput(workspaceDir, "capacity-abort-waiting", "wait");
    const controller = new AbortController();
    await supervisor.launch(running, TEST_WORKER_ENDPOINT);
    const admission = supervisor.launch(waiting, TEST_WORKER_ENDPOINT, controller.signal);
    const rejected = expect(admission).rejects.toThrow("invoke cancelled");

    controller.abort(new Error("invoke cancelled"));
    await rejected;
    expect(new NodeWorkerLaunchStore({ env }).get(waiting.launchId)).toBeUndefined();
    await supervisor.close();
  });

  it("aborts saturated admission when the supervisor closes", async () => {
    const { env, supervisor, workspaceDir } = fixture({ capacity: 1, capacityWaitMs: 5_000 });
    const running = launchInput(workspaceDir, "capacity-close-running", "wait");
    const waiting = launchInput(workspaceDir, "capacity-close-waiting", "wait");
    await supervisor.launch(running, TEST_WORKER_ENDPOINT);
    const admission = supervisor.launch(waiting, TEST_WORKER_ENDPOINT);
    const rejected = expect(admission).rejects.toThrow("node worker supervisor is closed");
    await vi.waitFor(() => {
      expect(new NodeWorkerLaunchStore({ env }).get(waiting.launchId)).toBeUndefined();
    });

    await supervisor.close();
    await rejected;
    expect(new NodeWorkerLaunchStore({ env }).get(waiting.launchId)).toBeUndefined();
  });

  it.each(["status", "launch", "cancel", "close"] as const)(
    "retains an observed terminal outcome when %s reconciliation keeps failing",
    async (operation) => {
      const capacitySnapshots: Array<{ total: number; available: number }> = [];
      const { env, supervisor, workspaceDir } = fixture({
        capacity: 1,
        onCapacityChanged: (capacity) => capacitySnapshots.push(capacity),
      });
      const input = launchInput(workspaceDir, `finish-failure-${operation}`);
      const store = (supervisor as unknown as { store: NodeWorkerLaunchStore }).store;
      const originalFinish = store.finish.bind(store);
      let persistenceUnavailable = true;
      const finish = vi.spyOn(store, "finish").mockImplementation((params) => {
        if (persistenceUnavailable) {
          throw new Error("injected finish failure");
        }
        return originalFinish(params);
      });
      const invoke = async () => {
        switch (operation) {
          case "status":
            return await supervisor.status(input.launchId);
          case "launch":
            return await supervisor.launch(input, TEST_WORKER_ENDPOINT);
          case "cancel":
            return await supervisor.cancel(testNodeWorkerLaunchIdentity(input));
          case "close":
            await supervisor.close();
            return new NodeWorkerLaunchStore({ env }).get(input.launchId);
          default:
            throw new Error("unsupported reconciliation operation");
        }
      };

      expect(await supervisor.launch(input, TEST_WORKER_ENDPOINT)).toMatchObject({
        state: "running",
      });
      await vi.waitFor(() => expect(finish).toHaveBeenCalled(), { timeout: 5_000 });
      expect(new NodeWorkerLaunchStore({ env }).get(input.launchId)?.state).toBe("running");
      expect(capacitySnapshots.at(-1)).toEqual({ total: 1, available: 0 });

      await expect(invoke()).rejects.toThrow("injected finish failure");
      expect(new NodeWorkerLaunchStore({ env }).get(input.launchId)?.state).toBe("running");
      expect(capacitySnapshots.at(-1)).toEqual({ total: 1, available: 0 });

      persistenceUnavailable = false;
      const completed = await invoke();
      expect(completed).toMatchObject({
        state: "completed",
        resultJson: expect.stringContaining('"status":"completed"'),
      });
      expect(new NodeWorkerLaunchStore({ env }).get(input.launchId)?.state).toBe("completed");
      expect(capacitySnapshots.at(-1)).toEqual({ total: 1, available: 1 });
      await supervisor.close();
    },
  );

  it("spawns workers with only supplied runtime essentials", async () => {
    const root = tempDirs.make("node-worker-env-");
    const { bundleRoot, env, workspaceDir } = writeNodeWorkerFixture(root);
    const suppliedPathKey = process.platform === "win32" ? "Path" : "PATH";
    const suppliedEnv: NodeJS.ProcessEnv = {
      ...env,
      [suppliedPathKey]: process.env.PATH,
      HOME: path.join(root, "worker-home"),
      LANG: "en_US.UTF-8",
      LC_TIME: "de_DE.UTF-8",
      NODE_EXTRA_CA_CERTS: path.join(root, "private-ca.pem"),
      NODE_USE_SYSTEM_CA: "1",
      OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1",
      OPENCLAW_SUPPLIED_SECRET: "supplied-openclaw-secret",
      NODE_OPTIONS: "--title=forbidden-worker-title",
      BASH_ENV: path.join(root, "forbidden-shell-init"),
      DYLD_INSERT_LIBRARIES: path.join(root, "forbidden-runtime-injection"),
      HTTPS_PROXY: "http://supplied-proxy.invalid",
      SUPPLIED_SECRET: "supplied-secret",
    };

    await withEnvAsync(
      {
        AMBIENT_SECRET: "ambient-secret",
        OPENCLAW_AMBIENT_SECRET: "ambient-openclaw-secret",
        HTTP_PROXY: "http://ambient-proxy.invalid",
        NODE_OPTIONS: undefined,
      },
      async () => {
        const expectedWorkerEnv: NodeJS.ProcessEnv = {
          HOME: suppliedEnv.HOME,
          LANG: suppliedEnv.LANG,
          LC_TIME: suppliedEnv.LC_TIME,
          NODE_EXTRA_CA_CERTS: suppliedEnv.NODE_EXTRA_CA_CERTS,
          NODE_USE_SYSTEM_CA: suppliedEnv.NODE_USE_SYSTEM_CA,
          NODE_COMPILE_CACHE: expect.stringContaining("node-worker-compile-cache"),
          OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: suppliedEnv.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS,
          OPENCLAW_NO_RESPAWN: "1",
          [suppliedPathKey]: suppliedEnv[suppliedPathKey],
        };
        const supervisor = createNodeWorkerSupervisor({ bundleRoot, env: suppliedEnv });
        suppliedEnv.HOME = path.join(root, "mutated-home");
        suppliedEnv.LANG = "mutated-locale";
        const input = launchInput(workspaceDir, "env-launch", "env");
        await supervisor.launch(input, TEST_WORKER_ENDPOINT);
        const completed = await waitForTerminal(supervisor, input.launchId);
        const workerEnv = JSON.parse(completed.resultJson ?? "null") as Record<string, string>;

        expect(workerEnv).toMatchObject(expectedWorkerEnv);
        expect(workerEnv).not.toHaveProperty("AMBIENT_SECRET");
        expect(workerEnv).not.toHaveProperty("OPENCLAW_AMBIENT_SECRET");
        expect(workerEnv).not.toHaveProperty("OPENCLAW_STATE_DIR");
        expect(workerEnv).not.toHaveProperty("OPENCLAW_SUPPLIED_SECRET");
        expect(workerEnv).not.toHaveProperty("NODE_OPTIONS");
        expect(workerEnv).not.toHaveProperty("BASH_ENV");
        expect(workerEnv).not.toHaveProperty("DYLD_INSERT_LIBRARIES");
        expect(workerEnv).not.toHaveProperty("HTTP_PROXY");
        expect(workerEnv).not.toHaveProperty("HTTPS_PROXY");
        expect(workerEnv).not.toHaveProperty("SUPPLIED_SECRET");
        expect(JSON.stringify(workerEnv)).not.toContain(TEST_WORKER_CREDENTIAL);
        const platformInjectedKeys =
          process.platform === "darwin" ? ["__CF_USER_TEXT_ENCODING"] : [];
        expect(Object.keys(workerEnv).toSorted()).toEqual(
          [...Object.keys(expectedWorkerEnv), ...platformInjectedKeys]
            .filter(
              (key) => expectedWorkerEnv[key] !== undefined || platformInjectedKeys.includes(key),
            )
            .toSorted(),
        );
        await supervisor.close();
      },
    );
  });

  it("bounds output and scrubs launch credentials after registry eviction", async () => {
    const { supervisor, workspaceDir } = fixture();
    const successInput = launchInput(workspaceDir, "secret-success-launch", "secret-success");
    const failureInput = launchInput(workspaceDir, "failure-launch", "secret-fail");
    const overflowInput = launchInput(workspaceDir, "overflow-launch", "overflow");

    await supervisor.launch(successInput, TEST_WORKER_ENDPOINT);
    await supervisor.launch(failureInput, TEST_WORKER_ENDPOINT);
    await supervisor.launch(overflowInput, TEST_WORKER_ENDPOINT);
    for (let index = 0; index < 600; index += 1) {
      registerSecretValueForRedaction(`eviction-secret-${index}`);
    }
    const success = await waitForTerminal(supervisor, successInput.launchId);
    const failure = await waitForTerminal(supervisor, failureInput.launchId);
    const overflow = await waitForTerminal(supervisor, overflowInput.launchId);
    const representations = [
      TEST_WORKER_CREDENTIAL,
      encodeURIComponent(TEST_WORKER_CREDENTIAL),
      JSON.stringify(TEST_WORKER_CREDENTIAL).slice(1, -1),
    ];
    expect(success.state).toBe("completed");
    expect(JSON.parse(success.resultJson ?? "null")).toEqual({
      raw: "[REDACTED]",
      encoded: "[REDACTED]",
      status: "completed",
    });
    expect(failure.state).toBe("failed");
    expect(Buffer.byteLength(failure.errorText ?? "", "utf8")).toBeLessThanOrEqual(4 * 1024);
    for (const representation of representations) {
      expect(success.resultJson).not.toContain(representation);
      expect(failure.errorText).not.toContain(representation);
    }
    expect(overflow).toMatchObject({
      state: "failed",
      errorText: expect.stringContaining("stdout exceeded 65536 bytes"),
    });
    await supervisor.close();
  });

  it.each([
    ["raw", "secret-cutoff-raw", TEST_WORKER_CREDENTIAL],
    ["URL", "secret-cutoff-url", encodeURIComponent(TEST_WORKER_CREDENTIAL)],
    ["JSON-escaped", "secret-cutoff-json", JSON.stringify(TEST_WORKER_CREDENTIAL).slice(1, -1)],
  ])(
    "redacts a %s credential representation across the stderr cutoff",
    async (_, prompt, representation) => {
      const { supervisor, workspaceDir } = fixture();
      const input = launchInput(workspaceDir, `cutoff-${prompt}`, prompt);

      await supervisor.launch(input, TEST_WORKER_ENDPOINT);
      const failure = await waitForTerminal(supervisor, input.launchId);

      expect(failure.state).toBe("failed");
      expect(Buffer.byteLength(failure.errorText ?? "", "utf8")).toBeLessThanOrEqual(4 * 1024);
      expect(failure.errorText).not.toContain(representation);
      expect(failure.errorText).not.toContain(representation.slice(-8));
      await supervisor.close();
    },
  );

  it("returns a terminal receipt when execution-ready races an immediate child completion", async () => {
    const { supervisor, workspaceDir } = fixture();
    const input = launchInput(workspaceDir, "fast-terminal-launch", "fast-terminal");
    vi.spyOn(NodeWorkerLaunchStore.prototype, "markRunning").mockImplementation(
      function (this: NodeWorkerLaunchStore, params) {
        return this.finish({
          launchId: params.launchId,
          planHash: params.planHash,
          supervisor: params.supervisor,
          worker: null,
          state: "completed",
          resultJson: '{"status":"completed"}',
        });
      },
    );

    expect(await supervisor.launch(input, TEST_WORKER_ENDPOINT)).toMatchObject({
      state: "completed",
    });
    const marker = path.join(workspaceDir, "fast-terminal-marker");
    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });
    expect(fs.existsSync(marker)).toBe(true);
    await supervisor.close();
  });

  it("records a gated child that exits before journal readiness as terminal", async () => {
    const { supervisor, workspaceDir } = fixture();
    const input = launchInput(workspaceDir, "prestart-exit-launch", "exit-before-start");
    const exitedPath = path.join(workspaceDir, "prestart-exited");

    await supervisor.launch(input, TEST_WORKER_ENDPOINT);
    const terminal = await waitForTerminal(supervisor, input.launchId);

    expect(fs.existsSync(exitedPath)).toBe(true);
    expect(terminal).toMatchObject({ state: "failed", worker: null });
    await supervisor.close();
  });

  it("fails closed before durable running when the child acknowledges another launch", async () => {
    const { env, supervisor, workspaceDir } = fixture();
    const input = launchInput(workspaceDir, "wrong-execution-ack-launch", "wrong-execution-ack");

    await expect(supervisor.launch(input, TEST_WORKER_ENDPOINT)).resolves.toMatchObject({
      state: "interrupted",
      worker: null,
    });
    expect(new NodeWorkerLaunchStore({ env }).get(input.launchId)).toMatchObject({
      state: "interrupted",
      worker: null,
    });
    await supervisor.close();
  });

  it("persists cancellation before a child acknowledgement without a worker identity", async () => {
    const { env, supervisor, workspaceDir } = fixture();
    const input = launchInput(
      workspaceDir,
      "cancel-before-execution-ack-launch",
      "wait-before-execution-ack",
    );
    const launching = supervisor.launch(input, TEST_WORKER_ENDPOINT);
    await vi.waitFor(async () => {
      expect((await supervisor.status(input.launchId))?.state).toBe("pending");
    });

    await expect(supervisor.cancel(testNodeWorkerLaunchIdentity(input))).resolves.toMatchObject({
      state: "cancelled",
      worker: null,
    });
    await expect(launching).resolves.toMatchObject({ state: "cancelled", worker: null });
    expect(new NodeWorkerLaunchStore({ env }).get(input.launchId)).toMatchObject({
      state: "cancelled",
      worker: null,
    });
    await supervisor.close();
  });

  it("interrupts a pending child on close without a durable worker identity", async () => {
    const { env, supervisor, workspaceDir } = fixture();
    const input = launchInput(
      workspaceDir,
      "close-before-execution-ack-launch",
      "wait-before-execution-ack",
    );
    const launching = supervisor.launch(input, TEST_WORKER_ENDPOINT);
    await vi.waitFor(async () => {
      expect((await supervisor.status(input.launchId))?.state).toBe("pending");
    });

    await supervisor.close();
    await expect(launching).resolves.toMatchObject({ state: "interrupted", worker: null });
    expect(new NodeWorkerLaunchStore({ env }).get(input.launchId)).toMatchObject({
      state: "interrupted",
      worker: null,
    });
  });

  it("retires a child that replays its execution acknowledgement after durable readiness", async () => {
    const { supervisor, workspaceDir } = fixture();
    const input = launchInput(
      workspaceDir,
      "replayed-execution-ack-launch",
      "replayed-execution-ack",
    );

    await expect(supervisor.launch(input, TEST_WORKER_ENDPOINT)).resolves.toMatchObject({
      state: "running",
      worker: expect.any(Object),
    });
    await vi.waitFor(async () => {
      expect((await supervisor.status(input.launchId))?.state).toBe("interrupted");
    });
    expect(await supervisor.status(input.launchId)).toMatchObject({
      state: "interrupted",
      worker: expect.any(Object),
    });
    await supervisor.close();
  });

  it.each([
    ["cancel", "cancelled"],
    ["close", "interrupted"],
  ] as const)("records %s while awaiting the owned child", async (operation, state) => {
    const { supervisor, workspaceDir } = fixture();
    const input = launchInput(workspaceDir, `${operation}-launch`, "wait");
    expect(await supervisor.launch(input, TEST_WORKER_ENDPOINT)).toMatchObject({
      state: "running",
    });

    if (operation === "cancel") {
      await supervisor.cancel(testNodeWorkerLaunchIdentity(input));
    } else {
      await supervisor.close();
    }

    expect(await supervisor.status(input.launchId)).toMatchObject({
      state,
      worker: { pid: expect.any(Number), startTime: expect.any(Number) },
    });
    await supervisor.close();
  });

  it("records the child's last gateway connection failure when cancelling admission", async () => {
    const { supervisor, workspaceDir } = fixture();
    const input = launchInput(workspaceDir, "connection-failure-launch", "connection-failure");
    expect(
      await supervisor.launch(input, {
        kind: "websocket",
        url: "wss://gateway.example/__openclaw__/worker",
      }),
    ).toMatchObject({
      state: "running",
    });
    await vi.waitFor(() =>
      expect(fs.existsSync(path.join(workspaceDir, "connection-failure-reported"))).toBe(true),
    );

    const cancelled = await supervisor.cancel(testNodeWorkerLaunchIdentity(input));
    expect(cancelled).toMatchObject({
      state: "cancelled",
      errorText: expect.stringMatching(
        /^worker could not reach gateway gateway\.example: certificate rejected .+; check TLS pin\/publicUrl configuration$/u,
      ),
    });
    expect(cancelled?.errorText).not.toContain(TEST_WORKER_CREDENTIAL);
    await supervisor.close();
  });

  it.each([
    ["cancel", "cancelled"],
    ["close", "interrupted"],
  ] as const)(
    "%s after execution readiness settles the durable terminal receipt",
    async (operation, state) => {
      const { supervisor, workspaceDir } = fixture();
      const input = launchInput(workspaceDir, `${operation}-startup-launch`, "tree");
      const originalMarkRunning = Object.getOwnPropertyDescriptor(
        NodeWorkerLaunchStore.prototype,
        "markRunning",
      )?.value as NodeWorkerLaunchStore["markRunning"];
      let stopping: Promise<unknown> | undefined;
      vi.spyOn(NodeWorkerLaunchStore.prototype, "markRunning").mockImplementation(
        function (this: NodeWorkerLaunchStore, params) {
          const receipt = Reflect.apply(originalMarkRunning, this, [params]);
          stopping =
            operation === "cancel"
              ? supervisor.cancel(testNodeWorkerLaunchIdentity(input))
              : supervisor.close();
          return receipt;
        },
      );

      await supervisor.launch(input, TEST_WORKER_ENDPOINT);
      await stopping;

      expect((await supervisor.status(input.launchId))?.state).toBe(state);
      await supervisor.close();
    },
  );

  it("does not return stale running after the active worker disappears", async () => {
    const { supervisor, workspaceDir } = fixture();
    const input = launchInput(workspaceDir, "silent-worker-death", "wait");
    const running = await supervisor.launch(input, TEST_WORKER_ENDPOINT);
    expect(running.worker).not.toBeNull();

    process.kill(running.worker!.pid, "SIGKILL");
    await vi.waitFor(async () => {
      expect((await supervisor.status(input.launchId))?.state).not.toBe("running");
    });
    await supervisor.close();
  });

  it("never signals a running worker for a mismatched immutable cancel identity", async () => {
    const { supervisor, workspaceDir } = fixture();
    const input = launchInput(workspaceDir, "identity-cancel-launch", "wait");
    const running = await supervisor.launch(input, TEST_WORKER_ENDPOINT);
    const expected = testNodeWorkerLaunchIdentity(input);
    const mismatches = [
      { ...expected, launchId: "launch-other" },
      { ...expected, planHash: "b".repeat(64) },
      { ...expected, environmentId: "environment-other" },
      { ...expected, sessionId: "session-other" },
      { ...expected, ownerEpoch: expected.ownerEpoch + 1 },
      { ...expected, placementGeneration: expected.placementGeneration + 1 },
      { ...expected, runId: "run-other" },
    ];

    for (const mismatch of mismatches) {
      await expect(supervisor.cancel(mismatch)).resolves.toBeUndefined();
      expect(inspectNodeWorkerProcessIdentity(running.worker!)).toBe("live");
      expect((await supervisor.status(input.launchId))?.state).toBe("running");
    }

    await expect(supervisor.cancel(expected)).resolves.toMatchObject({ state: "cancelled" });
    await supervisor.close();
  });

  it.each([
    ["cancel", "cancelled"],
    ["close", "interrupted"],
  ] as const)("%s terminates the worker-owned grandchild", async (operation, state) => {
    const { supervisor, workspaceDir } = fixture();
    const input = launchInput(workspaceDir, `${operation}-tree-launch`, "tree");
    const running = await supervisor.launch(input, TEST_WORKER_ENDPOINT);
    expect(running.state).toBe("running");
    const grandchildPath = path.join(workspaceDir, "grandchild.pid");
    await vi.waitFor(() => expect(fs.readFileSync(grandchildPath, "utf8")).toMatch(/^[1-9]\d*$/u));
    const grandchildPid = Number(fs.readFileSync(grandchildPath, "utf8"));
    const grandchild = requireNodeWorkerProcessIdentity(grandchildPid);
    expect(inspectNodeWorkerProcessIdentity(grandchild)).toBe("live");

    if (operation === "cancel") {
      await supervisor.cancel(testNodeWorkerLaunchIdentity(input));
    } else {
      await supervisor.close();
    }

    const terminal = await supervisor.status(input.launchId);
    expect(terminal).toMatchObject({ state, worker: running.worker });
    await vi.waitFor(() => {
      expect(inspectNodeWorkerProcessIdentity(running.worker!)).not.toBe("live");
      expect(inspectNodeWorkerProcessIdentity(grandchild)).not.toBe("live");
    });
    await supervisor.close();
  });

  it("fails closed when the bundle entry resolves outside its namespaced bundle", async () => {
    const { bundleRoot, root, supervisor, workspaceDir } = fixture();
    const escapedHash = "b".repeat(64);
    const escapedBundle = path.join(bundleRoot, "gateway-1", "bundles", escapedHash);
    const outsideEntry = path.join(root, "outside.mjs");
    fs.mkdirSync(escapedBundle, { recursive: true });
    fs.writeFileSync(outsideEntry, TEST_WORKER_SOURCE);
    fs.symlinkSync(outsideEntry, path.join(escapedBundle, "worker.mjs"));
    const input = launchInput(workspaceDir, "escaped-entry");
    input.expectedBundleHash = escapedHash;
    input.descriptor.admission.handshake.bundleHash = escapedHash;

    expect(await supervisor.launch(input, TEST_WORKER_ENDPOINT)).toMatchObject({
      state: "failed",
      errorText: expect.stringContaining("inside its bundle"),
    });
    await supervisor.close();
  });
});
