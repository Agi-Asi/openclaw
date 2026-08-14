import { randomUUID } from "node:crypto";
/**
 * Core-owned staging for one authorized memory virtual view.
 *
 * The broker provides only opaque handles and logical virtual paths. Core
 * materializes their bytes in private sandbox state, then hands Docker a
 * physical, read-only mount plan. Plugin artifact roots and normal workspace
 * mounts never cross here.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { AuthorizedMemoryVirtualView } from "../../../packages/memory-host-sdk/src/host/authorization.js";
import {
  resolveAuthorizedVirtualProjectionMountPlan,
  resolveAuthorizedVirtualProjectionRoot,
  resolveAuthorizedVirtualProjectionSourcePath,
  type AuthorizedVirtualProjectionMountPlan,
} from "./authorized-virtual-projection-mounts.js";

export type AuthorizedVirtualProjectionBroker = Readonly<{
  view: AuthorizedMemoryVirtualView;
  readFile: (virtualPath: string) => Promise<string | undefined>;
}>;

export type StagedAuthorizedVirtualProjectionMountPlan = Readonly<{
  plan: AuthorizedVirtualProjectionMountPlan;
  dispose: () => Promise<void>;
}>;

function assertVirtualPathForRoot(params: { virtualPath: string; virtualRoot: string }): string {
  const normalized = params.virtualPath.normalize("NFC");
  const parts = normalized.split("/");
  if (
    normalized !== params.virtualPath ||
    parts.length !== 2 ||
    parts[0] !== params.virtualRoot ||
    !parts[1] ||
    parts[1] === "." ||
    parts[1] === ".." ||
    parts[1]!.includes("\\")
  ) {
    throw new Error("Sandbox authorized projection manifest path is invalid.");
  }
  return parts[1]!;
}

async function ensureRealProjectionRoot(agentWorkspaceDir: string): Promise<void> {
  const root = resolveAuthorizedVirtualProjectionRoot(agentWorkspaceDir);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Sandbox authorized projection root must be a real directory.");
  }
}

/**
 * Stages all manifest files before returning a mount plan. `readFile` records
 * durable exposure before resolving its bytes, so no staged file can race a
 * missing exposure receipt. Any unavailable file removes this partial view.
 */
export async function stageAuthorizedVirtualProjectionMountPlan(params: {
  agentWorkspaceDir: string;
  broker: AuthorizedVirtualProjectionBroker;
}): Promise<StagedAuthorizedVirtualProjectionMountPlan> {
  const { view } = params.broker;
  const stagingId = `mst1_${randomUUID()}`;
  await ensureRealProjectionRoot(params.agentWorkspaceDir);

  const stagedPaths: string[] = [];
  try {
    const mounts = [];
    for (const root of view.roots) {
      if (root.access !== "read") {
        throw new Error("Sandbox authorized projection mounts must be read-only.");
      }
      const sourcePath = resolveAuthorizedVirtualProjectionSourcePath({
        agentWorkspaceDir: params.agentWorkspaceDir,
        viewId: view.viewId,
        revision: view.revision,
        stagingId,
        mountHandle: root.mountHandle,
      });
      // A repeated exact-revision staging attempt must not retain a file that
      // no longer appears in the broker manifest before its directory is mounted.
      await fs.rm(sourcePath, { recursive: true, force: true });
      await fs.mkdir(sourcePath, { mode: 0o700 });
      stagedPaths.push(sourcePath);
      const files = view.files
        .filter((file) => file.mountHandle === root.mountHandle)
        .toSorted((left, right) => left.virtualPath.localeCompare(right.virtualPath));
      for (const file of files) {
        const filename = assertVirtualPathForRoot({
          virtualPath: file.virtualPath,
          virtualRoot: root.virtualRoot,
        });
        const content = await params.broker.readFile(file.virtualPath);
        if (content === undefined) {
          throw new Error("Sandbox authorized projection content is unavailable.");
        }
        const temporaryPath = path.join(sourcePath, `.${filename}.tmp`);
        await fs.writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
        await fs.rename(temporaryPath, path.join(sourcePath, filename));
      }
      mounts.push(
        Object.freeze({
          mountHandle: root.mountHandle,
          virtualRoot: root.virtualRoot,
          sourcePath,
          access: "read" as const,
        }),
      );
    }
    const plan = Object.freeze({
      version: 1 as const,
      viewId: view.viewId,
      revision: view.revision,
      stagingId,
      mounts: Object.freeze(mounts),
    });
    // Validate the staged paths before releasing a plan to a backend. This
    // keeps a partially staged or forged source from becoming a bind mount.
    resolveAuthorizedVirtualProjectionMountPlan({
      agentWorkspaceDir: params.agentWorkspaceDir,
      plan,
    });
    return Object.freeze({
      plan,
      dispose: async () => {
        await Promise.all(
          stagedPaths.map((sourcePath) => fs.rm(sourcePath, { recursive: true, force: true })),
        );
      },
    });
  } catch (error) {
    await Promise.all(
      stagedPaths.map((sourcePath) => fs.rm(sourcePath, { recursive: true, force: true })),
    );
    throw error;
  }
}
