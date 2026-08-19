import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  DOCKER_SANDBOX_ENGINE,
  PODMAN_SANDBOX_ENGINE,
  execContainer,
  type SandboxContainerEngine,
} from "../agents/sandbox/docker.js";

/**
 * Process-isolated workers deliberately use one pinned runtime instead of the
 * configurable tool sandbox image. The image is part of the node-host TCB.
 */
export const NODE_WORKER_CONTAINER_IMAGE =
  "docker.io/library/node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d";
export const NODE_WORKER_CONTAINER_WORKSPACE = "/workspace";
export const NODE_WORKER_CONTAINER_MEMORY_ROOT = "/memory";
export const NODE_WORKER_CONTAINER_WORKER_ROOT = "/opt/openclaw/worker";
export const NODE_WORKER_CONTAINER_RELAY_ROOT = "/run/openclaw";
export const NODE_WORKER_CONTAINER_RELAY_SOCKET = `${NODE_WORKER_CONTAINER_RELAY_ROOT}/gateway.sock`;
export const NODE_WORKER_CONTAINER_SHIM_FLAG = "--internal-worker-container-shim";

const NODE_WORKER_CONTAINER_LABEL = "openclaw.node-worker-container";
const NODE_WORKER_CONTAINER_LAUNCH_LABEL = "openclaw.node-worker-launch";
const NODE_WORKER_CONTAINER_PLAN_LABEL = "openclaw.node-worker-plan";
const NODE_WORKER_CONTAINER_FORMAT = "v1";
const CONTAINER_NAME_MAX_CHARS = 96;
const NODE_WORKER_CONTAINER_ENGINE_TIMEOUT_MS = 5_000;
const NODE_WORKER_CONTAINER_IMAGE_PREPARE_TIMEOUT_MS = 2 * 60 * 1_000;

export type NodeWorkerContainerEngine = Extract<SandboxContainerEngine, { id: "docker" | "podman" }>;

export type NodeWorkerContainerIdentity = Readonly<{
  launchId: string;
  planHash: string;
}>;

export type NodeWorkerContainerMounts = Readonly<{
  bundleDir: string;
  relayDir: string;
  memoryDir: string;
  workspaceDir: string;
}>;

export function nodeWorkerContainerEngineFor(
  id: NodeWorkerContainerEngine["id"],
): NodeWorkerContainerEngine {
  return id === "docker" ? DOCKER_SANDBOX_ENGINE : PODMAN_SANDBOX_ENGINE;
}

/**
 * Probe and cleanup commands must not turn a wedged engine into an unbounded
 * worker lifecycle operation. `run` is intentionally excluded: it is the
 * worker lifetime itself and is owned by the shim's IPC lease.
 */
function runNodeWorkerContainerControlCommand(
  engine: NodeWorkerContainerEngine,
  args: string[],
  options?: { allowFailure?: boolean },
) {
  return execContainer(engine, args, {
    ...options,
    signal: AbortSignal.timeout(NODE_WORKER_CONTAINER_ENGINE_TIMEOUT_MS),
  });
}

/**
 * The worker image is part of the fixed container TCB. Pull it before this
 * host advertises process isolation: Docker's implicit cold pull can outlive
 * the short exact-container start probe and otherwise turns a ready node into
 * a failed first turn.
 */
async function prepareNodeWorkerContainerImage(engine: NodeWorkerContainerEngine): Promise<boolean> {
  const existing = await runNodeWorkerContainerControlCommand(
    engine,
    ["image", "inspect", "--format", "{{.Id}}", NODE_WORKER_CONTAINER_IMAGE],
    { allowFailure: true },
  );
  if (existing.code === 0 && existing.stdout.trim()) {
    return true;
  }
  const pulled = await execContainer(engine, ["pull", NODE_WORKER_CONTAINER_IMAGE], {
    allowFailure: true,
    signal: AbortSignal.timeout(NODE_WORKER_CONTAINER_IMAGE_PREPARE_TIMEOUT_MS),
  });
  return pulled.code === 0;
}

/** A mode-0600 relay is usable only by a concrete, non-root POSIX user mapping. */
export function resolveNodeWorkerContainerUser(): { uid: number; gid: number } | undefined {
  if (
    process.platform === "win32" ||
    typeof process.getuid !== "function" ||
    typeof process.getgid !== "function"
  ) {
    return undefined;
  }
  const uid = process.getuid();
  const gid = process.getgid();
  return uid === 0 || gid === 0 ? undefined : { uid, gid };
}

function requireOwnedAbsolutePath(value: string, label: string): string {
  if (!path.isAbsolute(value) || value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new Error(`node worker container ${label} must be an absolute local path`);
  }
  const lexicalStats = fs.lstatSync(value);
  if (lexicalStats.isSymbolicLink() || !lexicalStats.isDirectory()) {
    throw new Error(`node worker container ${label} must be a real local directory`);
  }
  const resolved = fs.realpathSync.native(value);
  const stats = fs.lstatSync(resolved);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`node worker container ${label} must be a real local directory`);
  }
  return resolved;
}

function formatMount(source: string, target: string, readOnly: boolean): string {
  return `type=bind,src=${source},dst=${target}${readOnly ? ",readonly" : ""}`;
}

function safeContainerNameComponent(value: string): string {
  const normalized = value.toLowerCase().replaceAll(/[^a-z0-9_.-]/gu, "-");
  const suffix = createHash("sha256").update(value).digest("hex").slice(0, 16);
  const prefix = normalized.replaceAll(/^-+|[-.]+$/gu, "").slice(0, 48) || "worker";
  return `${prefix}-${suffix}`;
}

/** A deterministic but collision-resistant container name, never a caller-provided Docker argument. */
export function nodeWorkerContainerName(identity: NodeWorkerContainerIdentity): string {
  const value = `openclaw-worker-${safeContainerNameComponent(identity.launchId)}-${identity.planHash.slice(0, 16)}`;
  return value.slice(0, CONTAINER_NAME_MAX_CHARS);
}

function assertContainerIdentity(identity: NodeWorkerContainerIdentity): void {
  if (
    identity.launchId.length === 0 ||
    identity.launchId.length > 256 ||
    identity.launchId.includes("\0") ||
    !/^[a-f0-9]{64}$/u.test(identity.planHash)
  ) {
    throw new Error("invalid node worker container identity");
  }
}

export function buildNodeWorkerContainerRunArgs(params: {
  engine: NodeWorkerContainerEngine;
  identity: NodeWorkerContainerIdentity;
  mounts: NodeWorkerContainerMounts;
  uid: number;
  gid: number;
}): string[] {
  assertContainerIdentity(params.identity);
  if (
    !Number.isSafeInteger(params.uid) ||
    params.uid <= 0 ||
    !Number.isSafeInteger(params.gid) ||
    params.gid <= 0
  ) {
    throw new Error("node worker container requires a concrete non-root host user mapping");
  }
  const bundleDir = requireOwnedAbsolutePath(params.mounts.bundleDir, "bundle mount");
  const relayDir = requireOwnedAbsolutePath(params.mounts.relayDir, "relay mount");
  const memoryDir = requireOwnedAbsolutePath(params.mounts.memoryDir, "memory projection mount");
  const workspaceDir = requireOwnedAbsolutePath(params.mounts.workspaceDir, "workspace mount");
  const name = nodeWorkerContainerName(params.identity);

  // This is intentionally a closed policy. The Gateway cannot pass a host path,
  // image, environment value, container option, or projection mount into it.
  return [
    "run",
    "--interactive",
    "--name",
    name,
    "--label",
    `${NODE_WORKER_CONTAINER_LABEL}=${NODE_WORKER_CONTAINER_FORMAT}`,
    "--label",
    `${NODE_WORKER_CONTAINER_LAUNCH_LABEL}=${params.identity.launchId}`,
    "--label",
    `${NODE_WORKER_CONTAINER_PLAN_LABEL}=${params.identity.planHash}`,
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,size=64m",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "128",
    "--memory",
    "512m",
    "--cpus",
    "1",
    "--user",
    `${params.uid}:${params.gid}`,
    "--workdir",
    NODE_WORKER_CONTAINER_WORKSPACE,
    "--mount",
    formatMount(bundleDir, NODE_WORKER_CONTAINER_WORKER_ROOT, true),
    "--mount",
    formatMount(relayDir, NODE_WORKER_CONTAINER_RELAY_ROOT, true),
    "--mount",
    formatMount(memoryDir, NODE_WORKER_CONTAINER_MEMORY_ROOT, true),
    "--mount",
    formatMount(workspaceDir, NODE_WORKER_CONTAINER_WORKSPACE, false),
    NODE_WORKER_CONTAINER_IMAGE,
    "node",
    `${NODE_WORKER_CONTAINER_WORKER_ROOT}/worker.mjs`,
  ];
}

/**
 * A node advertises process isolation only after one installed engine proves it
 * can service local container commands. Docker is preferred; Podman is the
 * supported equivalent when Docker is not available.
 */
export async function resolveNodeWorkerContainerEngine(): Promise<NodeWorkerContainerEngine | undefined> {
  if (!resolveNodeWorkerContainerUser()) {
    return undefined;
  }
  for (const engine of [DOCKER_SANDBOX_ENGINE, PODMAN_SANDBOX_ENGINE] as const) {
    try {
      const result = await runNodeWorkerContainerControlCommand(
        engine,
        ["info", "--format", "{{.ServerVersion}}"],
        {
        allowFailure: true,
        },
      );
      if (
        result.code === 0 &&
        result.stdout.trim().length > 0 &&
        (await prepareNodeWorkerContainerImage(engine))
      ) {
        return engine;
      }
    } catch {
      // An absent or unavailable engine means this node is ineligible, never a host fallback.
    }
  }
  return undefined;
}

async function listMatchingContainerIds(
  engine: NodeWorkerContainerEngine,
  identity: NodeWorkerContainerIdentity,
): Promise<string[]> {
  const result = await runNodeWorkerContainerControlCommand(
    engine,
    [
      "ps",
      "--all",
      "--quiet",
      "--filter",
      `label=${NODE_WORKER_CONTAINER_LABEL}=${NODE_WORKER_CONTAINER_FORMAT}`,
      "--filter",
      `label=${NODE_WORKER_CONTAINER_LAUNCH_LABEL}=${identity.launchId}`,
      "--filter",
      `label=${NODE_WORKER_CONTAINER_PLAN_LABEL}=${identity.planHash}`,
    ],
  );
  return result.stdout
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter((value) => /^[a-f0-9]{12,128}$/u.test(value));
}

async function isOwnedContainer(
  engine: NodeWorkerContainerEngine,
  containerId: string,
  identity: NodeWorkerContainerIdentity,
): Promise<boolean> {
  const result = await runNodeWorkerContainerControlCommand(
    engine,
    [
      "inspect",
      "--format",
      "{{.Name}}\n{{index .Config.Labels \"openclaw.node-worker-container\"}}\n{{index .Config.Labels \"openclaw.node-worker-launch\"}}\n{{index .Config.Labels \"openclaw.node-worker-plan\"}}",
      containerId,
    ],
  );
  const [rawName, format, launchId, planHash, ...extra] = result.stdout.trimEnd().split(/\r?\n/u);
  return (
    extra.length === 0 &&
    rawName === `/${nodeWorkerContainerName(identity)}` &&
    format === NODE_WORKER_CONTAINER_FORMAT &&
    launchId === identity.launchId &&
    planHash === identity.planHash
  );
}

/**
 * Prove the exact labelled container is accepting work before the shim attests
 * execution. The foreground `run` client being spawned is not that proof.
 */
export async function waitForOwnedNodeWorkerContainerRunning(params: {
  engine: NodeWorkerContainerEngine;
  identity: NodeWorkerContainerIdentity;
  timeoutMs?: number;
}): Promise<void> {
  assertContainerIdentity(params.identity);
  const deadline = Date.now() + (params.timeoutMs ?? 5_000);
  while (Date.now() < deadline) {
    const containerIds = await listMatchingContainerIds(params.engine, params.identity);
    for (const containerId of containerIds) {
      if (!(await isOwnedContainer(params.engine, containerId, params.identity))) {
        continue;
      }
      const state = await runNodeWorkerContainerControlCommand(params.engine, [
        "inspect",
        "--format",
        "{{.State.Running}}",
        containerId,
      ]);
      if (state.stdout.trim() === "true") {
        return;
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${params.engine.displayName} did not start the exact node worker container`);
}

async function containerStillMatches(
  engine: NodeWorkerContainerEngine,
  containerId: string,
  identity: NodeWorkerContainerIdentity,
): Promise<boolean> {
  return (await listMatchingContainerIds(engine, identity)).includes(containerId);
}

/** Removes only an exact, label-verified orphan from a prior shim/supervisor lifetime. */
export async function removeOwnedNodeWorkerContainers(
  identity: NodeWorkerContainerIdentity,
  engine: NodeWorkerContainerEngine,
): Promise<number> {
  assertContainerIdentity(identity);
  let removed = 0;
  const containerIds = await listMatchingContainerIds(engine, identity);
  for (const containerId of containerIds) {
    let owned: boolean;
    try {
      owned = await isOwnedContainer(engine, containerId, identity);
    } catch {
      // An inspect race is safe only when a second enumeration proves that the
      // listed container is gone. Any surviving container leaves cleanup open.
      if (!(await containerStillMatches(engine, containerId, identity))) {
        continue;
      }
      throw new Error(`${engine.displayName} could not inspect a node worker container`);
    }
    if (!owned) {
      continue;
    }
    try {
      await runNodeWorkerContainerControlCommand(engine, ["rm", "--force", containerId]);
      removed += 1;
    } catch {
      // A concurrent exit is already clean. Anything still enumerable is an
      // orphan and must keep the relay and launch recovery from settling.
      if (!(await containerStillMatches(engine, containerId, identity))) {
        continue;
      }
      throw new Error(`${engine.displayName} could not remove a node worker container`);
    }
  }
  return removed;
}
