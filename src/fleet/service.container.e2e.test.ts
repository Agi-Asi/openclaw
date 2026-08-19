import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { DOCKER_SANDBOX_ENGINE, execContainer } from "../agents/sandbox/docker.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { cellAuthSecretDir, cellContainerName, cellNetworkName } from "./cell-profile.js";
import { createFleetContainerRuntime } from "./containers.runtime.js";
import { createFleetService } from "./service.runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const DOCKER_COMMAND_TIMEOUT_MS = 30_000;

function uniqueTenant(prefix: string): string {
  return `${prefix}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
}

async function docker(args: string[], allowFailure = false) {
  return await execContainer(DOCKER_SANDBOX_ENGINE, args, {
    allowFailure,
    signal: AbortSignal.timeout(DOCKER_COMMAND_TIMEOUT_MS),
  });
}

function isMissingDockerObject(stderr: string): boolean {
  return /no such (?:container|network|object)|not found/iu.test(stderr);
}

async function cleanupCell(params: {
  service: ReturnType<typeof createFleetService>;
  tenant: string;
}): Promise<void> {
  try {
    await params.service.remove({ tenant: params.tenant, force: true, purgeData: true });
    return;
  } catch (serviceError) {
    // Preserve Fleet as the normal cleanup owner. These are exact, test-generated names only,
    // and recover a cell left behind by a failed health gate before the registry can remove it.
    const failures: unknown[] = [serviceError];
    for (const args of [
      ["rm", "--force", cellContainerName(params.tenant)],
      ["network", "rm", cellNetworkName(params.tenant)],
    ]) {
      const result = await docker(args, true);
      if (result.code !== 0 && !isMissingDockerObject(result.stderr)) {
        failures.push(new Error(result.stderr.trim() || `docker ${args.join(" ")} failed`));
      }
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, `Could not clean up Fleet cell ${params.tenant}.`);
    }
  }
}

describe.runIf(process.env.OPENCLAW_PROCESS_ISOLATION_E2E === "1")(
  "fleet separate-cell process isolation",
  () => {
    it("keeps a hostile tenant process out of another cell's data, credentials, mounts, and network", async () => {
      const image = process.env.OPENCLAW_FLEET_E2E_IMAGE;
      if (!image) {
        throw new Error(
          "Fleet process-isolation proof requires OPENCLAW_FLEET_E2E_IMAGE from the Docker E2E scheduler.",
        );
      }
      const root = tempDirs.make("openclaw-fleet-separate-cell-");
      const tenantA = uniqueTenant("fleeta");
      const tenantB = uniqueTenant("fleetb");
      const foreignSecret = crypto.randomBytes(16).toString("hex");
      const containers = createFleetContainerRuntime();
      const service = createFleetService({
        containers,
        env: { ...process.env, OPENCLAW_STATE_DIR: root },
      });
      try {
        const cellA = await service.create({
          tenant: tenantA,
          image,
          env: [
            "FLEET_CELL_E2E_A_MARKER=visible-only-to-a",
            `FLEET_CELL_E2E_A_SECRET=${crypto.randomBytes(16).toString("hex")}`,
            "OPENCLAW_SKIP_CHANNELS=1",
            "OPENCLAW_SKIP_GMAIL_WATCHER=1",
            "OPENCLAW_SKIP_CRON=1",
            "OPENCLAW_SKIP_CANVAS_HOST=1",
          ],
        });
        const cellB = await service.create({
          tenant: tenantB,
          image,
          env: [
            "FLEET_CELL_E2E_B_MARKER=visible-only-to-b",
            `FLEET_CELL_E2E_B_SECRET=${foreignSecret}`,
            "OPENCLAW_SKIP_CHANNELS=1",
            "OPENCLAW_SKIP_GMAIL_WATCHER=1",
            "OPENCLAW_SKIP_CRON=1",
            "OPENCLAW_SKIP_CANVAS_HOST=1",
          ],
        });

        // Each create already waits for its own /healthz response. Query status serially so this
        // isolation proof does not add an unrelated pair of cold-Gateway health requests.
        const statusA = await service.status(tenantA);
        const statusB = await service.status(tenantB);
        expect(statusA.container).toMatchObject({
          managed: true,
          running: true,
          state: "running",
        });
        expect(statusA.health, JSON.stringify(statusA.health)).toMatchObject({
          httpStatus: 200,
          status: "ok",
        });
        expect(statusB.container).toMatchObject({
          managed: true,
          running: true,
          state: "running",
        });
        expect(statusB.health, JSON.stringify(statusB.health)).toMatchObject({
          httpStatus: 200,
          status: "ok",
        });

        const doctor = await service.doctor();
        expect(doctor).toHaveLength(2);
        expect(
          doctor
            .flatMap((report) => report.findings)
            .filter((finding) => finding.status === "fail"),
        ).toEqual([]);

        const [pidA, pidB] = await Promise.all(
          [cellA.containerName, cellB.containerName].map(async (containerName) => {
            const result = await docker(["inspect", "--format", "{{.State.Pid}}", containerName]);
            expect(result.code, result.stderr).toBe(0);
            return Number(result.stdout.trim());
          }),
        );
        expect(pidA).toBeGreaterThan(0);
        expect(pidB).toBeGreaterThan(0);
        expect(pidA).not.toBe(pidB);

        const stateSentinel = "issued-a-memory-view";
        const foreignSentinel = "issued-b-memory-view";
        for (const [containerName, sentinelName, sentinel] of [
          [cellA.containerName, "issued-a.txt", stateSentinel],
          [cellB.containerName, "issued-b.txt", foreignSentinel],
        ] as const) {
          const result = await docker([
            "exec",
            containerName,
            "node",
            "-e",
            `require("node:fs").writeFileSync(require("node:path").join(process.env.OPENCLAW_STATE_DIR, ${JSON.stringify(sentinelName)}), ${JSON.stringify(sentinel)});`,
          ]);
          expect(result.code, result.stderr).toBe(0);
        }

        const foreignDataDir = statusB.dataDir;
        const foreignAuthDir = cellAuthSecretDir(root, tenantB);
        const hostileProbe = [
          'const fs = require("node:fs");',
          'const path = require("node:path");',
          `const foreignDataDir = ${JSON.stringify(foreignDataDir)};`,
          `const foreignAuthDir = ${JSON.stringify(foreignAuthDir)};`,
          `const foreignSecret = ${JSON.stringify(foreignSecret)};`,
          "const probe = (read) => { try { read(); return true; } catch { return false; } };",
          'const mountInfo = fs.readFileSync("/proc/self/mountinfo", "utf8");',
          "process.stdout.write(JSON.stringify({",
          '  ownSentinel: fs.readFileSync(path.join(process.env.OPENCLAW_STATE_DIR, "issued-a.txt"), "utf8"),',
          "  foreignDataDirectory: probe(() => fs.readdirSync(foreignDataDir)),",
          '  foreignDataSentinel: probe(() => fs.readFileSync(path.join(foreignDataDir, "issued-b.txt"), "utf8")),',
          "  foreignAuthDirectory: probe(() => fs.readdirSync(foreignAuthDir)),",
          '  foreignEnvironmentMarker: Object.hasOwn(process.env, "FLEET_CELL_E2E_B_MARKER"),',
          '  foreignEnvironmentSecret: Object.hasOwn(process.env, "FLEET_CELL_E2E_B_SECRET"),',
          "  foreignEnvironmentSecretValue: Object.values(process.env).includes(foreignSecret),",
          "  foreignMount: mountInfo.includes(foreignDataDir) || mountInfo.includes(foreignAuthDir),",
          "}));",
        ].join("\n");
        const hostileResult = await docker([
          "exec",
          cellA.containerName,
          "node",
          "-e",
          hostileProbe,
        ]);
        expect(hostileResult.code, hostileResult.stderr).toBe(0);
        expect(JSON.parse(hostileResult.stdout)).toEqual({
          ownSentinel: stateSentinel,
          foreignDataDirectory: false,
          foreignDataSentinel: false,
          foreignAuthDirectory: false,
          foreignEnvironmentMarker: false,
          foreignEnvironmentSecret: false,
          foreignEnvironmentSecretValue: false,
          foreignMount: false,
        });

        const inspectedMounts = await docker([
          "inspect",
          "--format",
          "{{json .Mounts}}",
          cellA.containerName,
        ]);
        expect(inspectedMounts.code, inspectedMounts.stderr).toBe(0);
        const mounts: unknown = JSON.parse(inspectedMounts.stdout);
        if (!Array.isArray(mounts)) {
          throw new Error("Fleet container inspection did not return mounts.");
        }
        const mountSources = mounts.flatMap((mount) => {
          if (
            !mount ||
            typeof mount !== "object" ||
            !("Source" in mount) ||
            typeof mount.Source !== "string"
          ) {
            return [];
          }
          return [mount.Source];
        });
        expect(mountSources).not.toContain(foreignDataDir);
        expect(mountSources).not.toContain(foreignAuthDir);

        const [networkA, networkB] = await Promise.all([
          containers.inspectNetwork("docker", cellNetworkName(tenantA)),
          containers.inspectNetwork("docker", cellNetworkName(tenantB)),
        ]);
        expect(networkA).toMatchObject({
          kind: "ok",
          attachedContainers: [{ name: cellA.containerName }],
        });
        expect(networkB).toMatchObject({
          kind: "ok",
          attachedContainers: [{ name: cellB.containerName }],
        });
        if (networkA.kind === "ok" && networkB.kind === "ok") {
          expect(networkA.attachedContainers).toHaveLength(1);
          expect(networkB.attachedContainers).toHaveLength(1);
        }
      } finally {
        await cleanupCell({ service, tenant: tenantB });
        await cleanupCell({ service, tenant: tenantA });
        closeOpenClawStateDatabaseForTest();
      }
    }, 150_000);
  },
);
