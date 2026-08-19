import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  completeWorkerLaunchDescriptor,
  parseWorkerLaunchDescriptor,
  type WorkerLaunchDescriptor,
} from "../worker/launch-descriptor.js";
import { createWorkerIpcLifetime } from "../worker/worker-process.js";
import type { WorkerConnectionEndpoint } from "../worker/worker-connection-endpoint.js";
import {
  buildNodeWorkerContainerRunArgs,
  nodeWorkerContainerEngineFor,
  NODE_WORKER_CONTAINER_SHIM_FLAG,
  NODE_WORKER_CONTAINER_RELAY_SOCKET,
  removeOwnedNodeWorkerContainers,
  resolveNodeWorkerContainerUser,
  waitForOwnedNodeWorkerContainerRunning,
  type NodeWorkerContainerEngine,
  type NodeWorkerContainerIdentity,
  type NodeWorkerContainerMounts,
} from "./node-worker-container-runtime.js";
import { startNodeWorkerGatewayRelay, type NodeWorkerGatewayRelay } from "./node-worker-gateway-relay.js";

const SHIM_INPUT_MAX_BYTES = 1024 * 1024;

type NodeWorkerContainerShimInput = Readonly<{
  descriptor: WorkerLaunchDescriptor;
  engine: NodeWorkerContainerEngine["id"];
  identity: NodeWorkerContainerIdentity;
  mounts: NodeWorkerContainerMounts;
}>;

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function parseContainerEngine(value: unknown): NodeWorkerContainerEngine["id"] | undefined {
  return value === "docker" || value === "podman" ? value : undefined;
}

function parseShimInput(raw: string): NodeWorkerContainerShimInput {
  if (Buffer.byteLength(raw, "utf8") > SHIM_INPUT_MAX_BYTES) {
    throw new Error("node worker container shim input exceeds its bound");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("node worker container shim input is malformed");
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["descriptor", "engine", "identity", "mounts"]) ||
    !isRecord(value.identity) ||
    !hasExactKeys(value.identity, ["launchId", "planHash"]) ||
    typeof value.identity.launchId !== "string" ||
    typeof value.identity.planHash !== "string" ||
    !isRecord(value.mounts) ||
    !hasExactKeys(value.mounts, ["bundleDir", "relayDir", "memoryDir", "workspaceDir"]) ||
    typeof value.mounts.bundleDir !== "string" ||
    typeof value.mounts.relayDir !== "string" ||
    typeof value.mounts.memoryDir !== "string" ||
    typeof value.mounts.workspaceDir !== "string"
  ) {
    throw new Error("node worker container shim input is invalid");
  }
  const engine = parseContainerEngine(value.engine);
  if (!engine) {
    throw new Error("node worker container shim engine is invalid");
  }
  const descriptor = parseWorkerLaunchDescriptor(value.descriptor);
  if (
    descriptor.assignment.workspaceDir !== "/workspace" ||
    (descriptor.assignment.workerContainmentRoot !== undefined &&
      descriptor.assignment.workerContainmentRoot !== "/workspace")
  ) {
    throw new Error("node worker container descriptor escaped its fixed workspace");
  }
  return {
    descriptor,
    engine,
    identity: { launchId: value.identity.launchId, planHash: value.identity.planHash },
    mounts: {
      bundleDir: value.mounts.bundleDir,
      relayDir: value.mounts.relayDir,
      memoryDir: value.mounts.memoryDir,
      workspaceDir: value.mounts.workspaceDir,
    },
  };
}

async function readShimInput(): Promise<NodeWorkerContainerShimInput> {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += String(chunk);
    if (Buffer.byteLength(raw, "utf8") > SHIM_INPUT_MAX_BYTES) {
      throw new Error("node worker container shim input exceeds its bound");
    }
  }
  return parseShimInput(raw);
}

function currentUser(): { uid: number; gid: number } {
  const user = resolveNodeWorkerContainerUser();
  if (!user) {
    throw new Error("node worker container execution requires a non-root POSIX host user mapping");
  }
  return user;
}

async function closeRelay(relay: NodeWorkerGatewayRelay | undefined): Promise<void> {
  await relay?.close().catch(() => undefined);
}

async function waitForChild(child: ChildProcessWithoutNullStreams): Promise<number> {
  const [code] = await once(child, "close");
  return typeof code === "number" ? code : 1;
}

/**
 * The shim, not Docker, is the worker PID in the durable journal. It waits on
 * inherited Node IPC before creating a disposable container and removes that
 * exact labelled container on any normal or signal-driven terminal path.
 */
export async function runNodeWorkerContainerShim(): Promise<void> {
  const input = await readShimInput();
  const lifetime = createWorkerIpcLifetime();
  let relay: NodeWorkerGatewayRelay | undefined;
  let child: ChildProcessWithoutNullStreams | undefined;
  let stopping = false;
  let finishStop!: () => void;
  const stopped = new Promise<void>((resolve) => {
    finishStop = resolve;
  });
  const engine = nodeWorkerContainerEngineFor(input.engine);

  const stop = async () => {
    if (stopping) {
      return;
    }
    stopping = true;
    try {
      child?.kill("SIGTERM");
      await removeOwnedNodeWorkerContainers(input.identity, engine);
    } finally {
      await closeRelay(relay);
      relay = undefined;
      lifetime.dispose();
      finishStop();
    }
  };
  const onSignal = () => {
    void stop();
  };
  const onSupervisorGone = () => {
    void stop();
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  // The IPC channel is the supervisor's ownership lease. Without this, a
  // killed supervisor can strand a still-running shim and its container.
  lifetime.signal.addEventListener("abort", onSupervisorGone, { once: true });
  if (lifetime.signal.aborted) {
    void stop();
  }

  try {
    const started = await Promise.race([lifetime.started, stopped.then(() => false)]);
    if (!started || stopping) {
      return;
    }
    await fs.mkdir(input.mounts.relayDir, { recursive: true, mode: 0o700 });
    await fs.chmod(input.mounts.relayDir, 0o700);
    relay = await startNodeWorkerGatewayRelay({
      directory: input.mounts.relayDir,
      upstream: input.descriptor.connectionEndpoint,
    });
    // A descriptor includes its host-only Gateway endpoint. Rebuild it from
    // the validated plan so the container receives only the mounted relay.
    const containerDescriptor = completeWorkerLaunchDescriptor(
      {
        version: input.descriptor.version,
        admission: input.descriptor.admission,
        assignment: input.descriptor.assignment,
      },
      {
        kind: "unix",
        socketPath: NODE_WORKER_CONTAINER_RELAY_SOCKET,
      } satisfies WorkerConnectionEndpoint,
    );
    const runArgs = buildNodeWorkerContainerRunArgs({
      engine,
      identity: input.identity,
      mounts: input.mounts,
      ...currentUser(),
    });
    child = spawn(engine.command, runArgs, {
      cwd: input.mounts.workspaceDir,
      env: process.env,
      stdio: ["pipe", "inherit", "inherit"],
      windowsHide: true,
    });
    child.stdin.end(JSON.stringify(containerDescriptor));
    await waitForOwnedNodeWorkerContainerRunning({ engine, identity: input.identity });
    // Container execution begins only after an exact label-bound inspect says Running.
    lifetime.reportExecutionStarted();
    const code = await Promise.race([waitForChild(child), stopped.then(() => 143)]);
    if (!stopping) {
      await removeOwnedNodeWorkerContainers(input.identity, engine);
    }
    process.exitCode = code;
  } catch (error) {
    lifetime.reportConnectionFailure(error instanceof Error ? error.message : "container worker unavailable");
    process.exitCode = 1;
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    lifetime.signal.removeEventListener("abort", onSupervisorGone);
    await stop();
  }
}

if (process.argv.includes(NODE_WORKER_CONTAINER_SHIM_FLAG)) {
  void runNodeWorkerContainerShim().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "node worker container shim failed"}\n`,
    );
    process.exitCode = 1;
  });
}
