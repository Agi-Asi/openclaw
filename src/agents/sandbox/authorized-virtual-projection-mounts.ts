/**
 * Authorized virtual projection mounts for sandboxed runs.
 *
 * The selected memory plugin names opaque handles and virtual roots only. Core
 * stages projection bytes in private sandbox state before this plan reaches a
 * container, so neither artifact storage nor a broadly mounted workspace can
 * become a projection source.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isPathInside } from "../../infra/path-guards.js";
import { splitSandboxBindSpec } from "./bind-spec.js";
import { SANDBOX_STATE_DIR } from "./constants.js";
import { resolveSandboxHostPathViaExistingAncestor } from "./host-paths.js";
import { normalizeContainerPathCore } from "./path-utils.js";

const AUTHORIZED_PROJECTION_DIRECTORY = ["authorized-memory-projections"] as const;
const AUTHORIZED_PROJECTION_CONTAINER_ROOT = "/memory";
const VIRTUAL_ROOT_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;

/** A core-staged, plugin-authorized read-only source for one virtual root. */
export type AuthorizedVirtualProjectionMount = Readonly<{
  mountHandle: string;
  virtualRoot: string;
  sourcePath: string;
  access: "read";
}>;

/**
 * Per-run authorization supplied by the memory broker, never persisted in the
 * sandbox config. `sourcePath` must be a core projection directory, not a
 * plugin artifact path.
 */
export type AuthorizedVirtualProjectionMountPlan = Readonly<{
  version: 1;
  viewId: string;
  revision: string;
  /** Core-issued per-staging lease; forces hot bind recreation after disposal. */
  stagingId: string;
  mounts: readonly AuthorizedVirtualProjectionMount[];
}>;

export type ResolvedAuthorizedVirtualProjectionMount = Readonly<
  AuthorizedVirtualProjectionMount & {
    containerPath: string;
  }
>;

function requireOpaqueId(value: string, label: string): string {
  if (!value.trim() || value !== value.trim() || value.length > 512) {
    throw new Error(`Sandbox authorized projection ${label} is invalid.`);
  }
  return value;
}

function normalizeContainerPath(value: string): string {
  return normalizeContainerPathCore(value).replace(/\/+$/, "") || "/";
}

function pathsCollide(left: string, right: string): boolean {
  const leftKey = normalizeContainerPath(left).toLocaleLowerCase("en-US");
  const rightKey = normalizeContainerPath(right).toLocaleLowerCase("en-US");
  return (
    leftKey === rightKey || leftKey.startsWith(`${rightKey}/`) || rightKey.startsWith(`${leftKey}/`)
  );
}

function canonicalCoreProjectionRoot(agentWorkspaceDir: string): {
  lexical: string;
  canonical: string;
} {
  const lexical = resolveAuthorizedVirtualProjectionRoot(agentWorkspaceDir);
  try {
    // A core projection directory must be a real directory. A symlink here
    // could turn an opaque projection mount into a plugin artifact mount.
    if (fs.lstatSync(lexical).isSymbolicLink()) {
      throw new Error("Sandbox authorized projection root must not be a symlink.");
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("must not be a symlink")) {
      throw error;
    }
    throw new Error("Sandbox authorized projection root is unavailable.");
  }
  return { lexical, canonical: resolveSandboxHostPathViaExistingAncestor(lexical) };
}

function assertCoreProjectionSource(params: {
  agentWorkspaceDir: string;
  sourcePath: string;
}): string {
  const root = canonicalCoreProjectionRoot(params.agentWorkspaceDir);
  const lexicalSource = path.resolve(params.sourcePath);
  if (!isPathInside(root.lexical, lexicalSource) || lexicalSource === root.lexical) {
    throw new Error("Sandbox authorized projection source is outside the core projection root.");
  }
  let sourceStat: fs.Stats;
  try {
    sourceStat = fs.lstatSync(lexicalSource);
  } catch {
    throw new Error("Sandbox authorized projection source is unavailable.");
  }
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error("Sandbox authorized projection source must be a real directory.");
  }
  const canonicalSource = resolveSandboxHostPathViaExistingAncestor(lexicalSource);
  if (!isPathInside(root.canonical, canonicalSource) || canonicalSource === root.canonical) {
    throw new Error("Sandbox authorized projection source escapes the core projection root.");
  }
  return canonicalSource;
}

function assertCoreProjectionFiles(sourcePath: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sourcePath, { withFileTypes: true });
  } catch {
    throw new Error("Sandbox authorized projection source is unavailable.");
  }
  for (const entry of entries) {
    const filePath = path.join(sourcePath, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(filePath);
    } catch {
      throw new Error("Sandbox authorized projection source is unavailable.");
    }
    // Core creates a flat set of new files for every view. A link or nested
    // entry could substitute host bytes between staging and the container bind.
    if (!entry.isFile() || entry.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
      throw new Error("Sandbox authorized projection source contains an unsafe file.");
    }
  }
}

/**
 * Core-owned root where a broker may materialize projection bytes for one agent.
 *
 * Do not put these bytes below `agentWorkspaceDir`: rw and ro sandboxes bind
 * that directory and would expose every staged projection outside `/memory`.
 */
export function resolveAuthorizedVirtualProjectionRoot(agentWorkspaceDir: string): string {
  const agentWorkspaceKey = createHash("sha256")
    .update(path.resolve(agentWorkspaceDir))
    .digest("hex");
  return path.join(SANDBOX_STATE_DIR, ...AUTHORIZED_PROJECTION_DIRECTORY, agentWorkspaceKey);
}

/**
 * Stable private directory name for one broker-staged projection revision.
 * Opaque IDs are hashed before becoming a host path, so neither plugin data
 * nor a view id can influence traversal or a model-visible location. Revision
 * identity is part of the path: whole-directory mounts must not inherit files
 * from an older manifest that reused the same view and mount handles.
 */
export function resolveAuthorizedVirtualProjectionSourcePath(params: {
  agentWorkspaceDir: string;
  viewId: string;
  revision: string;
  stagingId: string;
  mountHandle: string;
}): string {
  const digest = createHash("sha256")
    .update(
      `${requireOpaqueId(params.viewId, "view id")}\0${requireOpaqueId(params.revision, "revision")}\0${requireOpaqueId(params.stagingId, "staging id")}\0${requireOpaqueId(params.mountHandle, "mount handle")}`,
    )
    .digest("hex");
  return path.join(
    resolveAuthorizedVirtualProjectionRoot(params.agentWorkspaceDir),
    `p1_${digest}`,
  );
}

/**
 * Validates and deterministically orders a per-run projection plan. This is
 * the only path that turns a virtual root into a physical container target.
 */
export function resolveAuthorizedVirtualProjectionMountPlan(params: {
  agentWorkspaceDir: string;
  plan?: AuthorizedVirtualProjectionMountPlan;
}): readonly ResolvedAuthorizedVirtualProjectionMount[] {
  const plan = params.plan;
  if (!plan) {
    return [];
  }
  if (plan.version !== 1) {
    throw new Error("Sandbox authorized projection plan version is unsupported.");
  }
  requireOpaqueId(plan.viewId, "view id");
  requireOpaqueId(plan.revision, "revision");
  requireOpaqueId(plan.stagingId, "staging id");
  if (plan.mounts.length === 0) {
    throw new Error("Sandbox authorized projection plan must contain at least one mount.");
  }

  const handles = new Set<string>();
  const targets = new Set<string>();
  const resolved = plan.mounts.map((mount) => {
    const mountHandle = requireOpaqueId(mount.mountHandle, "mount handle");
    if (mount.access !== "read") {
      throw new Error("Sandbox authorized projection mounts must be read-only.");
    }
    if (
      !VIRTUAL_ROOT_PATTERN.test(mount.virtualRoot) ||
      mount.virtualRoot !== mount.virtualRoot.normalize("NFC")
    ) {
      throw new Error("Sandbox authorized projection virtual root is invalid.");
    }
    const virtualRoot = mount.virtualRoot;
    const containerPath = `${AUTHORIZED_PROJECTION_CONTAINER_ROOT}/${virtualRoot}`;
    const targetKey = containerPath.toLocaleLowerCase("en-US");
    if (handles.has(mountHandle) || targets.has(targetKey)) {
      throw new Error("Sandbox authorized projection mounts must not collide.");
    }
    handles.add(mountHandle);
    targets.add(targetKey);
    const expectedSourcePath = resolveAuthorizedVirtualProjectionSourcePath({
      agentWorkspaceDir: params.agentWorkspaceDir,
      viewId: plan.viewId,
      revision: plan.revision,
      stagingId: plan.stagingId,
      mountHandle,
    });
    if (path.resolve(mount.sourcePath) !== expectedSourcePath) {
      throw new Error(
        "Sandbox authorized projection source is not the core-issued projection path.",
      );
    }
    const sourcePath = assertCoreProjectionSource({
      agentWorkspaceDir: params.agentWorkspaceDir,
      sourcePath: mount.sourcePath,
    });
    assertCoreProjectionFiles(sourcePath);
    return Object.freeze({
      mountHandle,
      virtualRoot,
      sourcePath,
      access: "read" as const,
      containerPath,
    });
  });
  return Object.freeze(
    resolved.toSorted((left, right) => {
      const target = left.containerPath.localeCompare(right.containerPath);
      return target !== 0 ? target : left.mountHandle.localeCompare(right.mountHandle);
    }),
  );
}

/** Stable hash state; reordered equivalent plans do not recreate a container. */
export function formatAuthorizedVirtualProjectionMountHashState(
  plan: AuthorizedVirtualProjectionMountPlan | undefined,
  mounts: readonly ResolvedAuthorizedVirtualProjectionMount[],
): readonly string[] {
  if (!plan) {
    return [];
  }
  return Object.freeze([
    `view:${plan.viewId}`,
    `revision:${plan.revision}`,
    `staging:${plan.stagingId}`,
    ...mounts.map(
      (mount) => `${mount.containerPath}:${mount.access}:${mount.mountHandle}:${mount.sourcePath}`,
    ),
  ]);
}

/** Docker bind specs are deliberately always physically read-only and SELinux-shared. */
export function appendAuthorizedVirtualProjectionMountArgs(params: {
  args: string[];
  mounts: readonly ResolvedAuthorizedVirtualProjectionMount[];
}): void {
  for (const mount of params.mounts) {
    params.args.push("-v", `${mount.sourcePath}:${mount.containerPath}:ro,z`);
  }
}

/** Reject user-defined binds that could shadow, expose, or nest an authorized virtual root. */
export function assertNoBindsCollideWithAuthorizedVirtualProjectionMounts(params: {
  binds: readonly string[] | undefined;
  mounts: readonly ResolvedAuthorizedVirtualProjectionMount[];
}): void {
  if (!params.binds?.length || params.mounts.length === 0) {
    return;
  }
  for (const bind of params.binds) {
    const parsed = splitSandboxBindSpec(bind);
    if (!parsed) {
      continue;
    }
    const target = normalizeContainerPath(parsed.container);
    if (params.mounts.some((mount) => pathsCollide(target, mount.containerPath))) {
      throw new Error(
        `Sandbox bind mount "${bind}" conflicts with an authorized virtual projection target.`,
      );
    }
  }
}
