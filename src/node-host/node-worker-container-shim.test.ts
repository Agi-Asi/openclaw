import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { completeWorkerLaunchDescriptor } from "../worker/launch-descriptor.js";
import { nodeWorkerContainerName } from "./node-worker-container-runtime.js";
import { testWorkerDescriptor } from "./node-worker-supervisor.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const children = new Set<ChildProcess>();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  await Promise.all(
    [...children].map(
      async (child) =>
        await new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once("exit", () => resolve());
        }),
    ),
  );
  children.clear();
});

function writeFakeDocker(root: string, marker: string, containerName: string): string {
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir);
  const executable = path.join(binDir, "docker");
  fs.writeFileSync(
    executable,
    `#!/usr/bin/env node
      const fs = require("node:fs");
      const command = process.argv[2];
      fs.appendFileSync(${JSON.stringify(marker)}, command + "\\n");
      if (command === "ps") {
        process.stdout.write("abcdefabcdef\\n");
        process.exit(0);
      }
      if (command === "inspect") {
        const format = process.argv[process.argv.indexOf("--format") + 1];
        if (format === "{{.State.Running}}") {
          process.stdout.write("true\\n");
        } else {
          process.stdout.write(${JSON.stringify(
            `/${containerName}\nv1\nturn-1\n${"a".repeat(64)}\n`,
          )});
        }
        process.exit(0);
      }
      if (command === "run") {
        process.on("SIGTERM", () => process.exit(0));
        setInterval(() => {}, 1000);
      }
    `,
    { mode: 0o755 },
  );
  return binDir;
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
}

describe("node worker container shim", () => {
  it.runIf(process.platform !== "win32")(
    "stops its container command when the supervisor IPC lease disconnects",
    async () => {
      const root = tempDirs.make("node-worker-container-shim-");
      const marker = path.join(root, "docker-calls");
      const identity = { launchId: "turn-1", planHash: "a".repeat(64) };
      const binDir = writeFakeDocker(root, marker, nodeWorkerContainerName(identity));
      const bundleDir = path.join(root, "bundle");
      const relayDir = tempDirs.make("oc-worker-relay-", "/tmp");
      const memoryDir = path.join(root, "memory");
      const workspaceDir = path.join(root, "workspace");
      for (const directory of [bundleDir, memoryDir, workspaceDir]) {
        fs.mkdirSync(directory);
      }
      fs.writeFileSync(path.join(bundleDir, "worker.mjs"), "process.exit(0);\n");
      const descriptor = testWorkerDescriptor("/workspace");
      descriptor.assignment.memoryReadEnforced = true;
      const input = {
        descriptor: completeWorkerLaunchDescriptor(descriptor, {
          kind: "unix" as const,
          socketPath: path.join(root, "gateway.sock"),
        }),
        engine: "docker" as const,
        identity,
        mounts: { bundleDir, relayDir, memoryDir, workspaceDir },
      };
      const shimPath = path.resolve("src/node-host/node-worker-container-shim.ts");
      const child = fork(shimPath, ["--internal-worker-container-shim"], {
        // tsx resolves workspace aliases through the checkout's tsconfig. The
        // shim's actual container command still runs from `workspaceDir`.
        cwd: process.cwd(),
        env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` },
        // The shim's CWD is an isolated worker fixture, so a bare package
        // specifier would resolve from that fixture rather than this checkout.
        execArgv: ["--import", import.meta.resolve("tsx")],
        silent: true,
      });
      children.add(child);
      let stderr = "";
      const messages: unknown[] = [];
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("message", (message: unknown) => {
        messages.push(message);
      });
      child.stdin?.end(JSON.stringify(input));
      child.send({ type: "openclaw-worker-start-v1", ...identity });

      try {
        await vi.waitFor(() => expect(fs.readFileSync(marker, "utf8")).toContain("run\n"), {
          timeout: 5_000,
        });
      } catch (error) {
        throw new Error(
          `container shim did not launch the fake engine: ${stderr} ${JSON.stringify(messages)}`,
          { cause: error },
        );
      }
      await vi.waitFor(() =>
        expect(messages).toContainEqual({
          type: "openclaw-worker-execution-started-v1",
          ...identity,
        }),
      );
      child.disconnect();

      await vi.waitFor(
        () => expect(child.exitCode ?? child.signalCode).not.toBeNull(),
        { timeout: 5_000 },
      );
      await expect(waitForExit(child)).resolves.toBeUndefined();
      expect(fs.readFileSync(marker, "utf8")).toContain("ps\n");
    },
  );
});
