import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  resolveDefaultPluginNpmDir,
  resolvePluginNpmGenerationProjectDir,
  resolvePluginNpmProjectDir,
} from "./install-paths.js";

const compensationTempDirs = useAutoCleanupTempDirTracker(afterEach);

const mocks = vi.hoisted(() => ({
  applyUninstall: vi.fn(),
  clawhubInstall: vi.fn(),
  installRecords: vi.fn(),
  npmInstall: vi.fn(),
  pathInstall: vi.fn(),
  persistInstall: vi.fn(),
  planUninstall: vi.fn(),
}));

vi.mock("./clawhub.js", () => ({
  installPluginFromClawHub: (...args: unknown[]) => mocks.clawhubInstall(...args),
}));

vi.mock("./install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./install.js")>()),
  installPluginFromNpmSpec: (...args: unknown[]) => mocks.npmInstall(...args),
  installPluginFromPath: (...args: unknown[]) => mocks.pathInstall(...args),
}));

vi.mock("./install-persistence.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./install-persistence.js")>()),
  persistPluginInstall: (...args: unknown[]) => mocks.persistInstall(...args),
}));

vi.mock("./installed-plugin-index-records.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./installed-plugin-index-records.js")>()),
  loadInstalledPluginIndexInstallRecords: (...args: unknown[]) => mocks.installRecords(...args),
}));

vi.mock("./uninstall.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./uninstall.js")>()),
  applyPluginUninstallDirectoryRemoval: (...args: unknown[]) => mocks.applyUninstall(...args),
  planPluginUninstall: (...args: unknown[]) => mocks.planUninstall(...args),
}));

const { installManagedPluginSource } = await import("./management-service.js");
const actualInstall = await vi.importActual<typeof import("./install.js")>("./install.js");
const actualUninstall = await vi.importActual<typeof import("./uninstall.js")>("./uninstall.js");

function installPersistSnapshot() {
  return {
    config: {},
    baseHash: "base-hash",
    writeOptions: {
      expectedConfigPath: "/tmp/openclaw.json",
      includeFileHashesForWrite: { "/tmp/plugins.json": "include-hash" },
      includeFileTargetsForWrite: { "/tmp/plugins.json": "/tmp/plugins.json" },
    },
  };
}

function mockClawHubInstall(pluginId: string, packageName: string, targetDir: string) {
  mocks.clawhubInstall.mockResolvedValue({
    ok: true,
    pluginId,
    targetDir,
    extensions: ["index.js"],
    packageName,
    clawhub: {
      source: "clawhub",
      clawhubUrl: "https://clawhub.ai",
      clawhubPackage: packageName,
      clawhubFamily: "code-plugin",
    },
  });
}

async function writePluginFixture(root: string, version: string, generation: string) {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "@openclaw/demo",
      version,
      openclaw: { extensions: ["./index.js"] },
    }),
  );
  await fs.writeFile(
    path.join(root, "openclaw.plugin.json"),
    JSON.stringify({ id: "demo", configSchema: { type: "object", properties: {} } }),
  );
  await fs.writeFile(path.join(root, "index.js"), `export const generation = "${generation}";\n`);
}

async function listInstallBackups(extensionsDir: string): Promise<string[]> {
  return await fs.readdir(path.join(extensionsDir, ".openclaw-install-backups")).catch(() => []);
}

describe("managed plugin install compensation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.installRecords.mockResolvedValue({});
    mocks.applyUninstall.mockResolvedValue({ directoryRemoved: true, warnings: [] });
  });

  it("defaults direct managed source installs to persistence-failure cleanup", async () => {
    const env = { HOME: "/tmp/openclaw-managed-source-conflict-home" };
    const conflict = new Error("config changed during plugin install");
    const targetDir = "/tmp/openclaw-managed-source-conflict-home/extensions/demo";
    mockClawHubInstall("demo", "community/demo", targetDir);
    mocks.persistInstall.mockRejectedValue(conflict);
    mocks.planUninstall.mockReturnValue({
      ok: true,
      config: {},
      pluginId: "demo",
      actions: {},
      directoryRemoval: { target: targetDir },
    });

    await expect(
      installManagedPluginSource({
        request: { source: "clawhub", spec: "clawhub:community/demo" },
        snapshot: installPersistSnapshot(),
        env,
      }),
    ).rejects.toBe(conflict);

    expect(mocks.installRecords).toHaveBeenCalledWith({ env });
    expect(mocks.applyUninstall).toHaveBeenCalledWith({ target: targetDir });
  });

  it("restores the previous plugin payload when persistence rejects a forced replacement", async () => {
    const root = compensationTempDirs.make("openclaw-managed-source-transaction-");
    const stateRoot = path.join(root, "state");
    const extensionsDir = path.join(stateRoot, "extensions");
    const targetDir = path.join(extensionsDir, "demo");
    const candidateDir = path.join(root, "candidate");
    const conflict = new Error("config changed during plugin install");
    await writePluginFixture(targetDir, "1.0.0", "A");
    await writePluginFixture(candidateDir, "2.0.0", "B");
    mocks.pathInstall.mockImplementation(actualInstall.installPluginFromPath);
    mocks.installRecords.mockResolvedValue({
      demo: { source: "path", installPath: targetDir, version: "1.0.0" },
    });
    mocks.persistInstall.mockImplementation(async () => {
      await expect(fs.readFile(path.join(targetDir, "index.js"), "utf8")).resolves.toContain('"B"');
      expect(await listInstallBackups(extensionsDir)).toHaveLength(1);
      throw conflict;
    });

    await expect(
      installManagedPluginSource({
        request: {
          source: "local",
          path: candidateDir,
          recordSource: "path",
          mode: "update",
        },
        snapshot: installPersistSnapshot(),
        env: { HOME: root, OPENCLAW_STATE_DIR: stateRoot },
      }),
    ).rejects.toBe(conflict);

    await expect(fs.readFile(path.join(targetDir, "index.js"), "utf8")).resolves.toContain('"A"');
    await expect(fs.readFile(path.join(targetDir, "package.json"), "utf8")).resolves.toContain(
      '"1.0.0"',
    );
    expect(await listInstallBackups(extensionsDir)).toEqual([]);
    expect(mocks.applyUninstall).not.toHaveBeenCalled();
  });

  it("commits a replacement payload only after persistence succeeds", async () => {
    const root = compensationTempDirs.make("openclaw-managed-source-commit-");
    const stateRoot = path.join(root, "state");
    const extensionsDir = path.join(stateRoot, "extensions");
    const targetDir = path.join(extensionsDir, "demo");
    const candidateDir = path.join(root, "candidate");
    await writePluginFixture(targetDir, "1.0.0", "A");
    await writePluginFixture(candidateDir, "2.0.0", "B");
    mocks.pathInstall.mockImplementation(actualInstall.installPluginFromPath);
    mocks.persistInstall.mockImplementation(async () => {
      await expect(fs.readFile(path.join(targetDir, "index.js"), "utf8")).resolves.toContain('"B"');
      expect(await listInstallBackups(extensionsDir)).toHaveLength(1);
      return {};
    });

    const result = await installManagedPluginSource({
      request: {
        source: "local",
        path: candidateDir,
        recordSource: "path",
        mode: "update",
      },
      snapshot: installPersistSnapshot(),
      env: { HOME: root, OPENCLAW_STATE_DIR: stateRoot },
    });

    expect(result.ok).toBe(true);
    await expect(fs.readFile(path.join(targetDir, "index.js"), "utf8")).resolves.toContain('"B"');
    await expect(fs.readFile(path.join(targetDir, "package.json"), "utf8")).resolves.toContain(
      '"2.0.0"',
    );
    expect(await listInstallBackups(extensionsDir)).toEqual([]);
  });

  it.each([
    { name: "ordinary", generationKey: undefined },
    { name: "generation", generationKey: "demo-v2" },
  ])(
    "removes a planner-validated $name npm project after persistence conflicts",
    async (fixture) => {
      const home = compensationTempDirs.make("openclaw-managed-npm-conflict-");
      const env = { HOME: home };
      const packageName = "@openclaw/demo";
      const npmDir = resolveDefaultPluginNpmDir(env);
      const npmRoot = fixture.generationKey
        ? resolvePluginNpmGenerationProjectDir({
            npmDir,
            packageName,
            generationKey: fixture.generationKey,
          })
        : resolvePluginNpmProjectDir({ npmDir, packageName });
      const targetDir = path.join(npmRoot, "node_modules", "@openclaw", "demo");
      const packArchive = path.join(npmRoot, "_openclaw-pack-archives", "demo.tgz");
      const conflict = new Error("config changed during npm plugin install");

      await fs.mkdir(targetDir, { recursive: true });
      await fs.mkdir(path.dirname(packArchive), { recursive: true });
      await fs.writeFile(packArchive, "packed plugin");
      mocks.npmInstall.mockResolvedValue({
        ok: true,
        pluginId: "demo",
        targetDir,
        extensions: ["index.js"],
        manifestName: packageName,
      });
      mocks.persistInstall.mockRejectedValue(conflict);
      mocks.planUninstall.mockImplementation((params) =>
        actualUninstall.planPluginUninstall(
          params as Parameters<typeof actualUninstall.planPluginUninstall>[0],
        ),
      );
      mocks.applyUninstall.mockImplementation(async (removal: { target: string }) => {
        await fs.rm(removal.target, { recursive: true, force: true });
        return { directoryRemoved: true, warnings: [] };
      });

      await expect(
        installManagedPluginSource({
          request: { source: "npm", spec: packageName, mode: "install" },
          snapshot: installPersistSnapshot(),
          env,
        }),
      ).rejects.toBe(conflict);

      expect(mocks.applyUninstall).toHaveBeenCalledWith({
        target: npmRoot,
        cleanup: { kind: "npm", npmRoot, packageName, rootKind: "isolated-project" },
      });
      await expect(fs.access(npmRoot)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("never deletes an operator-owned source when link persistence fails", async () => {
    const env = { HOME: "/tmp/openclaw-managed-link-conflict-home" };
    const sourcePath = "/tmp/operator-owned-plugin-source";
    const conflict = new Error("config changed during plugin link");
    mocks.pathInstall.mockResolvedValue({
      ok: true,
      pluginId: "demo",
      targetDir: sourcePath,
      version: "1.0.0",
    });
    mocks.persistInstall.mockRejectedValue(conflict);

    await expect(
      installManagedPluginSource({
        request: {
          source: "local",
          path: sourcePath,
          recordSource: "path",
          mode: "install",
          link: true,
        },
        snapshot: installPersistSnapshot(),
        env,
        cleanupOnPersistenceFailure: true,
      }),
    ).rejects.toBe(conflict);

    expect(mocks.pathInstall).toHaveBeenCalledWith(
      expect.objectContaining({ path: sourcePath, dryRun: true }),
    );
    expect(mocks.installRecords).not.toHaveBeenCalled();
    expect(mocks.planUninstall).not.toHaveBeenCalled();
    expect(mocks.applyUninstall).not.toHaveBeenCalled();
  });
});
