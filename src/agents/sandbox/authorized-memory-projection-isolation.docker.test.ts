import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { startMemoryBrokerProcess, type MemoryBrokerProcess } from "../../memory-broker/process.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";

const dockerAvailable =
  spawnSync("docker", ["info"], { stdio: "ignore", timeout: 3_000 }).status === 0;

function createConfig(params: {
  image: string;
  prefix: string;
  workspaceRoot: string;
}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        skipBootstrap: true,
        sandbox: {
          mode: "all",
          backend: "docker",
          scope: "session",
          workspaceAccess: "none",
          workspaceRoot: params.workspaceRoot,
          docker: {
            image: params.image,
            containerPrefix: params.prefix,
          },
          browser: { enabled: false },
          prune: { idleHours: 0, maxAgeDays: 0 },
        },
      },
    },
  };
}

test.runIf(dockerAvailable)(
  "a malicious model-facing shell tool sees only its issued projection, never broker state",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-projection-e2e-"));
    const stateDir = path.join(root, "state");
    const workspaceDir = path.join(root, "workspace");
    const artifactRoot = path.join(root, "controlled-artifacts");
    const agentDatabasePath = path.join(
      stateDir,
      "agents",
      "memory-projection",
      "agent",
      "openclaw-agent.sqlite",
    );
    const siblingDatabasePath = path.join(
      stateDir,
      "agents",
      "hostile-tenant",
      "agent",
      "openclaw-agent.sqlite",
    );
    const image = process.env.OPENCLAW_SANDBOX_TEST_IMAGE ?? "openclaw-sandbox:bookworm-slim";
    const env = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_MEMORY_BROKER_TEST_SECRET"]);
    let disposeProjection: (() => Promise<void>) | undefined;
    let runtimeId: string | undefined;
    let stagedSourcePath: string | undefined;
    let broker: MemoryBrokerProcess | undefined;

    await fs.mkdir(artifactRoot, { recursive: true });
    await fs.writeFile(path.join(artifactRoot, "never-mounted.txt"), "host-only");
    await fs.mkdir(path.dirname(agentDatabasePath), { recursive: true });
    await fs.mkdir(path.dirname(siblingDatabasePath), { recursive: true });
    await fs.writeFile(agentDatabasePath, "private-agent-sqlite");
    await fs.writeFile(siblingDatabasePath, "hostile-tenant-sqlite");
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("OPENCLAW_MEMORY_BROKER_TEST_SECRET", "gateway-only-secret");

    try {
      const existingBrokerDirectories = new Set(
        (await fs.readdir(os.tmpdir())).filter((name) =>
          name.startsWith("openclaw-memory-broker-"),
        ),
      );
      broker = await startMemoryBrokerProcess({
        brokerId: "projection-isolation-test-broker",
        handlerModuleUrl: new URL("../../memory-broker/test-handler.mjs", import.meta.url).href,
      });
      let brokerSocketPath: string | undefined;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const directory = (await fs.readdir(os.tmpdir())).find(
          (name) =>
            name.startsWith("openclaw-memory-broker-") && !existingBrokerDirectories.has(name),
        );
        if (directory) {
          brokerSocketPath = path.join(os.tmpdir(), directory, "broker.sock");
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(brokerSocketPath).toBeDefined();
      await expect(fs.access(brokerSocketPath!)).resolves.toBeUndefined();
      const [{ resolveSandboxContext }, { stageAuthorizedVirtualProjectionMountPlan }] =
        await Promise.all([
          import("./context.js"),
          import("./authorized-virtual-projection-staging.js"),
        ]);
      const sessionId = randomUUID();
      const sandbox = await resolveSandboxContext({
        agentId: "memory-projection",
        config: createConfig({
          image,
          prefix: `oc-qa-memory-projection-${process.pid}-`,
          workspaceRoot: path.join(root, "sandboxes"),
        }),
        sessionKey: `agent:memory-projection:qa:${sessionId}`,
        workspaceDir,
        prepareAuthorizedVirtualProjectionMountPlan: async ({ agentWorkspaceDir }) => {
          const staged = await stageAuthorizedVirtualProjectionMountPlan({
            agentWorkspaceDir,
            broker: {
              view: {
                version: 1,
                viewId: "view-alice",
                planId: "plan-alice",
                contextFingerprint: "context-alice",
                revision: "revision-alice",
                roots: [
                  {
                    version: 1,
                    mountHandle: "mount-alice-private",
                    virtualRoot: "private",
                    access: "read",
                  },
                ],
                files: [
                  {
                    version: 1,
                    mountHandle: "mount-alice-private",
                    virtualPath: "private/allowed.txt",
                  },
                ],
                expiresAt: "2099-01-01T00:00:00.000Z",
              },
              readFile: async (virtualPath) =>
                virtualPath === "private/allowed.txt" ? "alice-only" : undefined,
            },
          });
          stagedSourcePath = staged.plan.mounts[0]?.sourcePath;
          return staged;
        },
      });
      expect(sandbox).not.toBeNull();
      if (!sandbox?.backend) {
        throw new Error("expected a provisioned Docker sandbox backend");
      }
      runtimeId = sandbox.runtimeId;
      disposeProjection = sandbox.disposeAuthorizedVirtualProjectionMountPlan;
      expect(stagedSourcePath).toBeDefined();
      await expect(fs.readFile(path.join(stagedSourcePath!, "allowed.txt"), "utf8")).resolves.toBe(
        "alice-only",
      );
      const canonicalStagedSourcePath = await fs.realpath(stagedSourcePath!);

      const { execDocker } = await import("./docker.js");
      const inspected = await execDocker(["inspect", runtimeId]);
      const mounts = JSON.parse(inspected.stdout) as Array<{
        Mounts?: Array<{ Destination?: string; Source?: string; RW?: boolean }>;
      }>;
      expect(mounts[0]?.Mounts).toContainEqual(
        expect.objectContaining({
          Destination: "/memory/private",
          Source: canonicalStagedSourcePath,
          RW: false,
        }),
      );

      const result = await sandbox.backend.runShellCommand({
        script: [
          'test "$(cat /memory/private/allowed.txt)" = alice-only',
          "test ! -e /memory/channel",
          "test ! -e /memory/shared",
          "test ! -e /memory/projections",
          'test ! -e "$1"',
          'test ! -e "$2"',
          'test ! -e "$3"',
          'test ! -e "$4"',
          'test ! -e "$5"',
          "test ! -e /workspace/allowed.txt",
          'test -z "${OPENCLAW_MEMORY_BROKER_TEST_SECRET:-}"',
          "! tr '\\0' '\\n' < /proc/1/environ 2>/dev/null | grep -Fqx gateway-only-secret",
          '! find /proc -path "*/fd/*" -lname "$1/*" -print -quit 2>/dev/null | grep -q .',
          '! find /proc -path "*/fd/*" -lname "$2" -print -quit 2>/dev/null | grep -q .',
          "! printf denied > /memory/private/write-attempt.txt",
        ].join(" && "),
        args: [artifactRoot, agentDatabasePath, siblingDatabasePath, stateDir, brokerSocketPath!],
      });
      expect(result.code, result.stderr.toString()).toBe(0);
      await expect(
        fs.access(path.join(artifactRoot, "never-mounted.txt")),
      ).resolves.toBeUndefined();
    } finally {
      if (runtimeId) {
        const [{ removeSandboxContainer }, { execDocker }] = await Promise.all([
          import("./manage.js"),
          import("./docker.js"),
        ]);
        await removeSandboxContainer(runtimeId);
        await execDocker(["rm", "-f", runtimeId], { allowFailure: true });
      }
      await disposeProjection?.();
      await broker?.close();
      env.restore();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);
