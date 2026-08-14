import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendAuthorizedVirtualProjectionMountArgs,
  assertNoBindsCollideWithAuthorizedVirtualProjectionMounts,
  formatAuthorizedVirtualProjectionMountHashState,
  resolveAuthorizedVirtualProjectionMountPlan,
  resolveAuthorizedVirtualProjectionSourcePath,
  resolveAuthorizedVirtualProjectionRoot,
  type AuthorizedVirtualProjectionMountPlan,
} from "./authorized-virtual-projection-mounts.js";

const tmpDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-authorized-projections-"));
  tmpDirs.push(dir);
  return dir;
}

function preparePlan(params?: {
  agentWorkspaceDir?: string;
  revision?: string;
  roots?: readonly string[];
}): { agentWorkspaceDir: string; plan: AuthorizedVirtualProjectionMountPlan } {
  const agentWorkspaceDir = params?.agentWorkspaceDir ?? makeTempDir();
  const roots = params?.roots ?? ["private", "projections-1"];
  fs.mkdirSync(resolveAuthorizedVirtualProjectionRoot(agentWorkspaceDir), { recursive: true });
  const mounts = roots.map((virtualRoot, index) => {
    const mountHandle = `opaque-mount-${index + 1}`;
    const sourcePath = resolveAuthorizedVirtualProjectionSourcePath({
      agentWorkspaceDir,
      viewId: "opaque-view",
      revision: params?.revision ?? "revision-1",
      stagingId: "stage-1",
      mountHandle,
    });
    fs.mkdirSync(sourcePath, { recursive: true });
    return { mountHandle, virtualRoot, sourcePath, access: "read" as const };
  });
  return {
    agentWorkspaceDir,
    plan: {
      version: 1,
      viewId: "opaque-view",
      revision: params?.revision ?? "revision-1",
      stagingId: "stage-1",
      mounts,
    },
  };
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(resolveAuthorizedVirtualProjectionRoot(dir), { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("authorized virtual projection mounts", () => {
  it("sorts opaque roots and emits physical read-only Docker mounts", () => {
    const { agentWorkspaceDir, plan } = preparePlan({ roots: ["projections-1", "private"] });
    const mounts = resolveAuthorizedVirtualProjectionMountPlan({ agentWorkspaceDir, plan });

    expect(mounts.map((mount) => mount.containerPath)).toEqual([
      "/memory/private",
      "/memory/projections-1",
    ]);
    const args: string[] = [];
    appendAuthorizedVirtualProjectionMountArgs({ args, mounts });
    expect(args).toEqual([
      "-v",
      `${mounts[0]!.sourcePath}:/memory/private:ro,z`,
      "-v",
      `${mounts[1]!.sourcePath}:/memory/projections-1:ro,z`,
    ]);
  });

  it("refuses raw artifact paths instead of treating them as core projections", () => {
    const { agentWorkspaceDir, plan } = preparePlan();
    const artifactDir = makeTempDir();
    expect(() =>
      resolveAuthorizedVirtualProjectionMountPlan({
        agentWorkspaceDir,
        plan: {
          ...plan,
          mounts: [{ ...plan.mounts[0]!, sourcePath: artifactDir }],
        },
      }),
    ).toThrow(/not the core-issued projection path/);
  });

  it("fails closed when the exact core-issued projection source is absent", () => {
    const { agentWorkspaceDir, plan } = preparePlan({ roots: ["private"] });
    fs.rmSync(plan.mounts[0]!.sourcePath, { recursive: true });
    expect(() => resolveAuthorizedVirtualProjectionMountPlan({ agentWorkspaceDir, plan })).toThrow(
      /source is unavailable/,
    );
  });

  it.runIf(process.platform !== "win32")(
    "refuses core projection sources that escape through symlinks",
    () => {
      const { agentWorkspaceDir, plan } = preparePlan({ roots: ["private"] });
      const outside = makeTempDir();
      const sourcePath = plan.mounts[0]!.sourcePath;
      fs.rmSync(sourcePath, { recursive: true });
      fs.symlinkSync(outside, sourcePath, "dir");

      expect(() =>
        resolveAuthorizedVirtualProjectionMountPlan({ agentWorkspaceDir, plan }),
      ).toThrow(/must be a real directory/);
    },
  );

  it.runIf(process.platform !== "win32")(
    "refuses a core projection file hard-linked to host content",
    () => {
      const { agentWorkspaceDir, plan } = preparePlan({ roots: ["private"] });
      const hostContent = path.join(makeTempDir(), "host-secret.txt");
      fs.writeFileSync(hostContent, "host-only");
      fs.linkSync(hostContent, path.join(plan.mounts[0]!.sourcePath, "linked.txt"));

      expect(() =>
        resolveAuthorizedVirtualProjectionMountPlan({ agentWorkspaceDir, plan }),
      ).toThrow(/contains an unsafe file/);
    },
  );

  it("rejects dangerous, noncanonical, and colliding virtual targets", () => {
    const { agentWorkspaceDir, plan } = preparePlan({ roots: ["private"] });
    const sourcePath = plan.mounts[0]!.sourcePath;
    for (const virtualRoot of [
      ".",
      "../private",
      "private/child",
      "PRIVATE",
      "privaté",
      "private\u0301",
    ] as const) {
      expect(() =>
        resolveAuthorizedVirtualProjectionMountPlan({
          agentWorkspaceDir,
          plan: { ...plan, mounts: [{ ...plan.mounts[0]!, virtualRoot }] },
        }),
      ).toThrow(/virtual root is invalid/);
    }
    expect(() =>
      resolveAuthorizedVirtualProjectionMountPlan({
        agentWorkspaceDir,
        plan: {
          ...plan,
          mounts: [
            { ...plan.mounts[0]! },
            { mountHandle: "opaque-mount-2", virtualRoot: "private", sourcePath, access: "read" },
          ],
        },
      }),
    ).toThrow(/must not collide/);
  });

  it("rejects custom binds that shadow an authorized root or its parent", () => {
    const { agentWorkspaceDir, plan } = preparePlan({ roots: ["private"] });
    const mounts = resolveAuthorizedVirtualProjectionMountPlan({ agentWorkspaceDir, plan });
    expect(() =>
      assertNoBindsCollideWithAuthorizedVirtualProjectionMounts({
        binds: ["/tmp/override:/memory:ro"],
        mounts,
      }),
    ).toThrow(/conflicts with an authorized virtual projection target/);
    expect(() =>
      assertNoBindsCollideWithAuthorizedVirtualProjectionMounts({
        binds: ["/tmp/override:/memory/private/nested:ro"],
        mounts,
      }),
    ).toThrow(/conflicts with an authorized virtual projection target/);
  });

  it("makes sorted view, revision, target, and access identity hashable", () => {
    const { agentWorkspaceDir, plan } = preparePlan({ roots: ["projections-1", "private"] });
    const mounts = resolveAuthorizedVirtualProjectionMountPlan({ agentWorkspaceDir, plan });
    const reversed = resolveAuthorizedVirtualProjectionMountPlan({
      agentWorkspaceDir,
      plan: { ...plan, mounts: [...plan.mounts].reverse() },
    });
    expect(formatAuthorizedVirtualProjectionMountHashState(plan, mounts)).toEqual(
      formatAuthorizedVirtualProjectionMountHashState(plan, reversed),
    );
    expect(
      formatAuthorizedVirtualProjectionMountHashState({ ...plan, revision: "revision-2" }, mounts),
    ).not.toEqual(formatAuthorizedVirtualProjectionMountHashState(plan, mounts));
    expect(
      formatAuthorizedVirtualProjectionMountHashState(plan, [
        { ...mounts[0]!, mountHandle: "opaque-mount-rebound" },
        ...mounts.slice(1),
      ]),
    ).not.toEqual(formatAuthorizedVirtualProjectionMountHashState(plan, mounts));
  });
});
