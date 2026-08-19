import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const containerMocks = vi.hoisted(() => ({ execContainer: vi.fn() }));

vi.mock("../agents/sandbox/docker.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/sandbox/docker.js")>(
    "../agents/sandbox/docker.js",
  );
  return { ...actual, execContainer: containerMocks.execContainer };
});

import { DOCKER_SANDBOX_ENGINE } from "../agents/sandbox/docker.js";
import {
  buildNodeWorkerContainerRunArgs,
  NODE_WORKER_CONTAINER_IMAGE,
  NODE_WORKER_CONTAINER_MEMORY_ROOT,
  NODE_WORKER_CONTAINER_RELAY_ROOT,
  NODE_WORKER_CONTAINER_WORKER_ROOT,
  NODE_WORKER_CONTAINER_WORKSPACE,
  nodeWorkerContainerName,
  removeOwnedNodeWorkerContainers,
  resolveNodeWorkerContainerEngine,
} from "./node-worker-container-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const identity = { launchId: "turn-1", planHash: "a".repeat(64) };

function mounts() {
  const root = tempDirs.make("node-worker-container-");
  const bundleDir = path.join(root, "bundle");
  const relayDir = path.join(root, "relay");
  const memoryDir = path.join(root, "memory");
  const workspaceDir = path.join(root, "workspace");
  for (const directory of [bundleDir, relayDir, memoryDir, workspaceDir]) {
    fs.mkdirSync(directory);
  }
  return { bundleDir, relayDir, memoryDir, workspaceDir };
}

afterEach(() => {
  containerMocks.execContainer.mockReset();
});

describe("node worker container runtime", () => {
  it("prepares the fixed worker image before admitting Docker process isolation", async () => {
    containerMocks.execContainer
      .mockResolvedValueOnce({ stdout: "27.5.1\n", stderr: "", code: 0 })
      .mockResolvedValueOnce({ stdout: "", stderr: "No such image", code: 1 })
      .mockResolvedValueOnce({ stdout: "pulled\n", stderr: "", code: 0 });

    await expect(resolveNodeWorkerContainerEngine()).resolves.toBe(DOCKER_SANDBOX_ENGINE);

    expect(containerMocks.execContainer.mock.calls).toEqual([
      [DOCKER_SANDBOX_ENGINE, ["info", "--format", "{{.ServerVersion}}"], expect.any(Object)],
      [
        DOCKER_SANDBOX_ENGINE,
        ["image", "inspect", "--format", "{{.Id}}", NODE_WORKER_CONTAINER_IMAGE],
        expect.any(Object),
      ],
      [DOCKER_SANDBOX_ENGINE, ["pull", NODE_WORKER_CONTAINER_IMAGE], expect.any(Object)],
    ]);
    expect(containerMocks.execContainer.mock.calls[2]?.[2]).toEqual(
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("does not advertise process isolation when the fixed worker image cannot be prepared", async () => {
    containerMocks.execContainer
      .mockResolvedValueOnce({ stdout: "27.5.1\n", stderr: "", code: 0 })
      .mockResolvedValueOnce({ stdout: "", stderr: "No such image", code: 1 })
      .mockResolvedValueOnce({ stdout: "", stderr: "registry unavailable", code: 1 })
      .mockResolvedValueOnce({ stdout: "", stderr: "podman unavailable", code: 1 });

    await expect(resolveNodeWorkerContainerEngine()).resolves.toBeUndefined();
  });

  it("builds a closed non-root container policy with only the worker mounts", () => {
    const paths = mounts();
    const args = buildNodeWorkerContainerRunArgs({
      engine: DOCKER_SANDBOX_ENGINE,
      identity,
      mounts: paths,
      uid: 501,
      gid: 20,
    });

    expect(args).toEqual(
      expect.arrayContaining([
        "--interactive",
        "--network",
        "none",
        "--read-only",
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
        "501:20",
        "--workdir",
        NODE_WORKER_CONTAINER_WORKSPACE,
        NODE_WORKER_CONTAINER_IMAGE,
      ]),
    );
    const mountValues = args.flatMap((value, index) =>
      value === "--mount" ? [args[index + 1]] : [],
    );
    expect(mountValues).toEqual([
      `type=bind,src=${fs.realpathSync(paths.bundleDir)},dst=${NODE_WORKER_CONTAINER_WORKER_ROOT},readonly`,
      `type=bind,src=${fs.realpathSync(paths.relayDir)},dst=${NODE_WORKER_CONTAINER_RELAY_ROOT},readonly`,
      `type=bind,src=${fs.realpathSync(paths.memoryDir)},dst=${NODE_WORKER_CONTAINER_MEMORY_ROOT},readonly`,
      `type=bind,src=${fs.realpathSync(paths.workspaceDir)},dst=${NODE_WORKER_CONTAINER_WORKSPACE}`,
    ]);
    expect(args).not.toContain("--privileged");
    expect(args).not.toContain("--network=host");
  });

  it("does not claim cleanup after container enumeration fails", async () => {
    containerMocks.execContainer.mockRejectedValueOnce(new Error("Docker daemon unavailable"));

    await expect(removeOwnedNodeWorkerContainers(identity, DOCKER_SANDBOX_ENGINE)).rejects.toThrow(
      "Docker daemon unavailable",
    );
    expect(containerMocks.execContainer).toHaveBeenCalledWith(
      DOCKER_SANDBOX_ENGINE,
      expect.any(Array),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("rejects a symlinked memory mount before it reaches the container engine", () => {
    const paths = mounts();
    const symlink = path.join(path.dirname(paths.memoryDir), "memory-link");
    fs.symlinkSync(paths.memoryDir, symlink);

    expect(() =>
      buildNodeWorkerContainerRunArgs({
        engine: DOCKER_SANDBOX_ENGINE,
        identity,
        mounts: { ...paths, memoryDir: symlink },
        uid: 501,
        gid: 20,
      }),
    ).toThrow("memory projection mount must be a real local directory");
  });

  it("keeps cleanup open when a label-verified container cannot be removed", async () => {
    const containerId = "b".repeat(64);
    containerMocks.execContainer
      .mockResolvedValueOnce({ stdout: `${containerId}\n`, stderr: "", code: 0 })
      .mockResolvedValueOnce({
        stdout: `/${nodeWorkerContainerName(identity)}\nv1\n${identity.launchId}\n${identity.planHash}\n`,
        stderr: "",
        code: 0,
      })
      .mockRejectedValueOnce(new Error("permission denied"))
      .mockResolvedValueOnce({ stdout: `${containerId}\n`, stderr: "", code: 0 });

    await expect(removeOwnedNodeWorkerContainers(identity, DOCKER_SANDBOX_ENGINE)).rejects.toThrow(
      "Docker could not remove a node worker container",
    );
    for (const [, , options] of containerMocks.execContainer.mock.calls) {
      expect(options).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal) }));
    }
  });
});
