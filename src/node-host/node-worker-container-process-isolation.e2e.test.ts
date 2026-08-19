import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyNodeWorkerContainerProjectionIsolation } from "../../test/helpers/node-worker-container-projection-isolation.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { AuthorizedMemoryVirtualFileBroker } from "../agents/memory-authorized-read-host.js";
import { execContainer } from "../agents/sandbox/docker.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  buildNodeWorkerContainerRunArgs,
  removeOwnedNodeWorkerContainers,
  resolveNodeWorkerContainerEngine,
  type NodeWorkerContainerEngine,
} from "./node-worker-container-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

function broker(
  expiresAt = new Date(Date.now() + 60_000).toISOString(),
): AuthorizedMemoryVirtualFileBroker {
  const files = new Map([["shared/brief.md", "only this issued virtual view"]]);
  return {
    view: {
      version: 1,
      viewId: "container-e2e-view",
      planId: "container-e2e-plan",
      contextFingerprint: "container-e2e-context",
      revision: "container-e2e-revision",
      roots: [
        {
          version: 1,
          mountHandle: "container-e2e-mount",
          virtualRoot: "shared",
          access: "read",
        },
      ],
      files: [
        {
          version: 1,
          mountHandle: "container-e2e-mount",
          virtualPath: "shared/brief.md",
        },
      ],
      expiresAt,
    },
    readFile: async (virtualPath) => files.get(virtualPath),
  };
}

describe.runIf(process.env.OPENCLAW_PROCESS_ISOLATION_E2E === "1")(
  "node worker container process isolation",
  () => {
    it("exposes only an immutable issued memory snapshot to the hostile worker process", async () => {
      const root = tempDirs.make("node-worker-container-isolation-");
      const bundleDir = path.join(root, "bundle");
      const relayDir = path.join(root, "relay");
      const memoryDir = path.join(root, "memory");
      const workspaceDir = path.join(root, "workspace");
      const outsideArtifact = path.join(root, "host-artifact.sqlite");
      const identity = { launchId: "hostile-worker-turn", planHash: "a".repeat(64) };
      for (const directory of [bundleDir, relayDir, memoryDir, workspaceDir]) {
        fs.mkdirSync(directory, { recursive: true });
      }
      fs.mkdirSync(path.join(memoryDir, "shared"));
      fs.writeFileSync(path.join(memoryDir, "shared", "issued.md"), "issued memory only", {
        mode: 0o400,
      });
      fs.chmodSync(path.join(memoryDir, "shared"), 0o500);
      fs.writeFileSync(outsideArtifact, "host-only artifact");
      fs.writeFileSync(
        path.join(bundleDir, "worker.mjs"),
        [
          'import fs from "node:fs";',
          `const outsideArtifact = ${JSON.stringify(outsideArtifact)};`,
          'const attempt = (operation) => { try { operation(); return "allowed"; } catch (error) { return error && typeof error === "object" && "code" in error ? String(error.code) : "denied"; } };',
          "const result = {",
          "  uid: process.getuid(),",
          '  issued: fs.readFileSync("/memory/shared/issued.md", "utf8"),',
          '  memoryWrite: attempt(() => fs.writeFileSync("/memory/shared/issued.md", "tampered")),',
          '  rawArtifactRead: attempt(() => fs.readFileSync(outsideArtifact, "utf8")),',
          '  workspaceWrite: attempt(() => fs.writeFileSync("/workspace/proof.txt", "allowed")),',
          "};",
          "process.stdout.write(JSON.stringify(result));",
        ].join("\n"),
        { mode: 0o500 },
      );
      let engine: NodeWorkerContainerEngine | undefined;
      try {
        engine = await resolveNodeWorkerContainerEngine();
        if (!engine) {
          throw new Error(
            "process-isolation proof requires an eligible Docker or Podman node host",
          );
        }
        await removeOwnedNodeWorkerContainers(identity, engine);
        const user = process.getuid?.();
        const group = process.getgid?.();
        if (!user || !group) {
          throw new Error("process-isolation proof requires a non-root POSIX test host");
        }
        const args = buildNodeWorkerContainerRunArgs({
          engine,
          identity,
          mounts: { bundleDir, relayDir, memoryDir, workspaceDir },
          uid: user,
          gid: group,
        });
        const result = await execContainer(engine, args, { allowFailure: true });
        expect(result.code, result.stderr).toBe(0);
        const observed: unknown = JSON.parse(result.stdout);
        expect(observed).toMatchObject({
          uid: user,
          issued: "issued memory only",
          rawArtifactRead: expect.not.stringMatching(/^allowed$/u),
          memoryWrite: expect.not.stringMatching(/^allowed$/u),
          workspaceWrite: "allowed",
        });
        expect(fs.readFileSync(path.join(memoryDir, "shared", "issued.md"), "utf8")).toBe(
          "issued memory only",
        );
        expect(fs.readFileSync(path.join(workspaceDir, "proof.txt"), "utf8")).toBe("allowed");
      } finally {
        fs.chmodSync(path.join(memoryDir, "shared"), 0o700);
        if (engine) {
          await removeOwnedNodeWorkerContainers(identity, engine);
        }
      }
    });

    it("withdraws an expired signed projection-backed container worker and its mounts", async () => {
      const root = tempDirs.make("node-worker-supervisor-container-e2e-");
      const outsideArtifactPath = path.join(root, "host-only-artifact.txt");
      fs.writeFileSync(outsideArtifactPath, "host-only artifact");
      const previousBrokerCredential =
        process.env.OPENCLAW_PROCESS_ISOLATION_TEST_BROKER_CREDENTIAL;
      process.env.OPENCLAW_PROCESS_ISOLATION_TEST_BROKER_CREDENTIAL = "test-broker-only-credential";
      try {
        await verifyNodeWorkerContainerProjectionIsolation({
          root,
          broker: broker(new Date(Date.now() + 15_000).toISOString()),
          outsideArtifactPath,
          outsideArtifactContents: "host-only artifact",
          issuedVirtualPath: "shared/brief.md",
          issuedContents: "only this issued virtual view",
          forbiddenEnvironmentVariable: "OPENCLAW_PROCESS_ISOLATION_TEST_BROKER_CREDENTIAL",
        });
      } finally {
        if (previousBrokerCredential === undefined) {
          delete process.env.OPENCLAW_PROCESS_ISOLATION_TEST_BROKER_CREDENTIAL;
        } else {
          process.env.OPENCLAW_PROCESS_ISOLATION_TEST_BROKER_CREDENTIAL = previousBrokerCredential;
        }
      }
    }, 90_000);
  },
);
