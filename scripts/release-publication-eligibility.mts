#!/usr/bin/env node
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { runTasksWithConcurrency } from "../src/utils/run-with-concurrency.ts";
import {
  collectClawHubPublishablePluginPackages,
  collectPluginClawHubReleasePlan,
  resolveClawHubPackagePublicationState,
  type ClawHubPackagePublicationState,
} from "./lib/plugin-clawhub-release.ts";
import {
  collectPluginReleasePlan,
  collectPublishablePluginPackages,
  type NpmLatestVersionResolver,
  type NpmPublishedVersionResolver,
  type PublishablePluginPackage,
} from "./lib/plugin-npm-release.ts";
import { validateReleasePlanLock, type ReleasePlanLock } from "./release-plan-contract.mjs";
import {
  canonicalReleasePublicationEligibilityReceiptJson,
  createReleasePublicationEligibilityReceipt,
  RELEASE_PUBLICATION_CLAWHUB_REGISTRY,
  RELEASE_PUBLICATION_ELIGIBILITY_MAX_AGE_MS,
  RELEASE_PUBLICATION_NPM_REGISTRY,
  verifyReleasePublicationEligibilityReceipt,
  type ReleasePublicationEligibilityReceipt,
} from "./release-publication-eligibility-contract.mjs";

const execFileAsync = promisify(execFile);
const OBSERVATION_CONCURRENCY = 8;
const NPM_OBSERVATION_ATTEMPTS = 3;
const NPM_OBSERVATION_TIMEOUT_MS = 60_000;
const CLAWHUB_OBSERVATION_TIMEOUT_MS = 30_000;
const compareAscii = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

type PackageIdentity = { name: string; version: string };
type AsyncLatestResolver = (packageName: string) => Promise<string>;
type AsyncPublishedResolver = (packageName: string, version: string) => Promise<boolean>;
type AsyncClawHubStateResolver = (
  plugin: Pick<PublishablePluginPackage, "packageName" | "version">,
) => Promise<ClawHubPackagePublicationState>;
type Observation =
  | { kind: "latest"; name: string; version: string }
  | { kind: "npm"; name: string; version: string; published: boolean }
  | ({
      kind: "clawhub";
      name: string;
      version: string;
    } & ClawHubPackagePublicationState);

type ObservationTask = {
  label: string;
  run: () => Promise<Observation>;
};

function packageIdentity(plugin: Pick<PublishablePluginPackage, "packageName" | "version">) {
  return { name: plugin.packageName, version: plugin.version };
}

function sortPackages<T extends PackageIdentity>(packages: T[]): T[] {
  return packages.toSorted((left, right) =>
    compareAscii(`${left.name}\0${left.version}`, `${right.name}\0${right.version}`),
  );
}

function samePackages(left: readonly PackageIdentity[], right: readonly PackageIdentity[]) {
  return JSON.stringify(sortPackages([...left])) === JSON.stringify(sortPackages([...right]));
}

function npmErrorDetail(error: unknown): string {
  const stderr =
    error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string"
      ? error.stderr
      : "";
  return `${error instanceof Error ? error.message : String(error)}\n${stderr}`;
}

function isTransientNpmObservationError(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "";
  return (
    ["EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "ETIMEDOUT"].includes(code) ||
    /\b(?:429|5[0-9]{2})\b|network|socket hang up|timed out/iu.test(npmErrorDetail(error))
  );
}

export async function retryNpmObservation<T>(
  operation: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolvePromise) => {
      setTimeout(resolvePromise, ms);
    }),
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= NPM_OBSERVATION_ATTEMPTS || !isTransientNpmObservationError(error)) {
        throw error;
      }
      await sleep(attempt * 1_000);
    }
  }
}

export function publicNpmObservationCommand(args: string[], userconfig: string) {
  return {
    args: [
      "view",
      ...args,
      "--json",
      "--registry",
      RELEASE_PUBLICATION_NPM_REGISTRY,
      "--userconfig",
      userconfig,
    ],
    env: {
      ...process.env,
      NPM_CONFIG_REGISTRY: RELEASE_PUBLICATION_NPM_REGISTRY,
      npm_config_registry: RELEASE_PUBLICATION_NPM_REGISTRY,
    },
  };
}

async function npmView(args: string[], userconfig: string): Promise<string> {
  return await retryNpmObservation(async () => {
    const command = publicNpmObservationCommand(args, userconfig);
    const { stdout } = await execFileAsync("npm", command.args, {
      encoding: "utf8",
      env: command.env,
      killSignal: "SIGKILL",
      timeout: NPM_OBSERVATION_TIMEOUT_MS,
    });
    return String(stdout).trim();
  });
}

function parseNpmVersion(raw: string, label: string): string {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`npm returned invalid JSON for ${label}`, { cause: error });
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`npm returned an invalid version for ${label}`);
  }
  return value.trim();
}

async function observeNpmLatest(packageName: string, userconfig: string): Promise<string> {
  return parseNpmVersion(
    await npmView([packageName, "dist-tags.latest"], userconfig),
    `${packageName} dist-tags.latest`,
  );
}

async function observeNpmPublished(
  packageName: string,
  version: string,
  userconfig: string,
): Promise<boolean> {
  try {
    parseNpmVersion(
      await npmView([`${packageName}@${version}`, "version"], userconfig),
      `${packageName}@${version}`,
    );
    return true;
  } catch (error) {
    if (/\bE404\b|404 Not Found/iu.test(npmErrorDetail(error))) {
      return false;
    }
    throw error;
  }
}

function collectLatestDependencyNames(
  npmPlugins: readonly PublishablePluginPackage[],
  clawHubPlugins: readonly PublishablePluginPackage[],
) {
  return [
    ...new Set(
      [...npmPlugins, ...clawHubPlugins].flatMap((plugin) =>
        (plugin.requiredLatestDependencies ?? []).map((dependency) => dependency.packageName),
      ),
    ),
  ].toSorted(compareAscii);
}

export async function collectReleasePublicationObservations(params: {
  npmPackages: readonly PackageIdentity[];
  clawHubPlugins: readonly PublishablePluginPackage[];
  latestDependencyNames: readonly string[];
  resolveLatestVersion: AsyncLatestResolver;
  resolveNpmPublishedVersion: AsyncPublishedResolver;
  resolveClawHubState: AsyncClawHubStateResolver;
}): Promise<{
  latestDependencies: Array<{ name: string; version: string }>;
  npm: Array<PackageIdentity & { published: boolean }>;
  clawHub: Array<PackageIdentity & ClawHubPackagePublicationState>;
}> {
  const tasks: ObservationTask[] = [
    ...[...new Set(params.latestDependencyNames)].toSorted(compareAscii).map((name) => ({
      label: `npm latest ${name}`,
      run: async () => ({
        kind: "latest" as const,
        name,
        version: await params.resolveLatestVersion(name),
      }),
    })),
    ...sortPackages([...params.npmPackages]).map(({ name, version }) => ({
      label: `npm publication ${name}@${version}`,
      run: async () => ({
        kind: "npm" as const,
        name,
        version,
        published: await params.resolveNpmPublishedVersion(name, version),
      }),
    })),
    ...sortPackages(params.clawHubPlugins.map(packageIdentity)).map(({ name, version }) => {
      const plugin = params.clawHubPlugins.find(
        (candidate) => candidate.packageName === name && candidate.version === version,
      );
      if (!plugin) {
        throw new Error(`missing ClawHub plugin metadata for ${name}@${version}`);
      }
      return {
        label: `ClawHub publication ${name}@${version}`,
        run: async () => ({
          kind: "clawhub" as const,
          name,
          version,
          ...(await params.resolveClawHubState(plugin)),
        }),
      };
    }),
  ];
  const errors: string[] = [];
  const result = await runTasksWithConcurrency<Observation>({
    tasks: tasks.map((task) => task.run),
    limit: OBSERVATION_CONCURRENCY,
    errorMode: "continue",
    onTaskError: (error, index) => {
      errors.push(
        `${tasks[index]?.label ?? `observation ${index}`}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    },
  });
  if (errors.length > 0) {
    throw new Error(
      `release publication eligibility observation failures (${errors.length}):\n${errors
        .map((error) => `- ${error}`)
        .join("\n")}`,
    );
  }
  return {
    latestDependencies: result.results
      .filter((entry) => entry.kind === "latest")
      .map(({ name, version }) => ({ name, version })),
    npm: result.results
      .filter((entry) => entry.kind === "npm")
      .map(({ name, version, published }) => ({ name, version, published })),
    clawHub: result.results
      .filter((entry) => entry.kind === "clawhub")
      .map(({ name, version, packageExists, hasTrustedPublisher, alreadyPublished }) => ({
        name,
        version,
        packageExists,
        hasTrustedPublisher,
        alreadyPublished,
      })),
  };
}

function writeReceipt(path: string, receipt: ReleasePublicationEligibilityReceipt): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, canonicalReleasePublicationEligibilityReceiptJson(receipt), {
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
}

function readRootVersion(rootDir: string): string {
  const manifest = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (typeof manifest.version !== "string" || !manifest.version) {
    throw new Error("candidate package.json version is required");
  }
  return manifest.version;
}

function verifyCandidateCheckout(rootDir: string, candidateSha: string): void {
  let head: string;
  try {
    head = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error("publication eligibility requires a git candidate checkout");
  }
  if (head !== candidateSha) {
    throw new Error(
      `publication eligibility checkout ${head} does not match ReleasePlan candidate ${candidateSha}`,
    );
  }
}

export async function collectReleasePublicationEligibility(params: {
  releasePlanLock: ReleasePlanLock;
  receiptPath: string;
  rootDir?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  resolveLatestVersion?: AsyncLatestResolver;
  resolveNpmPublishedVersion?: AsyncPublishedResolver;
  resolveClawHubState?: AsyncClawHubStateResolver;
  sleep?: (ms: number) => Promise<void>;
}): Promise<ReleasePublicationEligibilityReceipt> {
  rmSync(params.receiptPath, { force: true });
  const lock = validateReleasePlanLock(params.releasePlanLock);
  if (lock.plan.purpose !== "beta-publish" && lock.plan.purpose !== "stable-publish") {
    throw new Error("publication eligibility requires a publish ReleasePlan");
  }
  const rootDir = resolve(params.rootDir ?? ".");
  verifyCandidateCheckout(rootDir, lock.plan.candidate_sha);
  if (readRootVersion(rootDir) !== lock.plan.version) {
    throw new Error("candidate checkout version does not match the ReleasePlan");
  }
  const now = params.now ?? Date.now;
  const startedAt = now();

  const npmPackages = lock.plan.inventory.packages
    .filter((entry) => entry.targets.includes("npm"))
    .map(({ name, version }) => ({ name, version }));
  const clawHubPackages = lock.plan.inventory.packages
    .filter((entry) => entry.targets.includes("clawhub"))
    .map(({ name, version }) => ({ name, version }));
  const npmPlugins = collectPublishablePluginPackages(rootDir);
  const clawHubPlugins = collectClawHubPublishablePluginPackages(rootDir);
  if (!samePackages(clawHubPlugins.map(packageIdentity), clawHubPackages)) {
    throw new Error("ClawHub package inventory drifted from the ReleasePlan");
  }
  const npmInventoryKeys = new Set(npmPackages.map(({ name, version }) => `${name}\0${version}`));
  const unplannedNpmPlugin = npmPlugins.find(
    (plugin) => !npmInventoryKeys.has(`${plugin.packageName}\0${plugin.version}`),
  );
  if (unplannedNpmPlugin) {
    throw new Error(
      `npm plugin inventory drifted from the ReleasePlan: ${unplannedNpmPlugin.packageName}@${unplannedNpmPlugin.version}`,
    );
  }

  const npmRoot = mkdtempSync(join(tmpdir(), "openclaw-release-eligibility-"));
  const npmUserconfig = join(npmRoot, "npmrc");
  writeFileSync(npmUserconfig, "", { mode: 0o600 });
  try {
    const observations = await collectReleasePublicationObservations({
      npmPackages,
      clawHubPlugins,
      latestDependencyNames: collectLatestDependencyNames(npmPlugins, clawHubPlugins),
      resolveLatestVersion:
        params.resolveLatestVersion ??
        ((packageName) => observeNpmLatest(packageName, npmUserconfig)),
      resolveNpmPublishedVersion:
        params.resolveNpmPublishedVersion ??
        ((packageName, version) => observeNpmPublished(packageName, version, npmUserconfig)),
      resolveClawHubState:
        params.resolveClawHubState ??
        ((plugin) =>
          resolveClawHubPackagePublicationState(plugin, {
            registryBaseUrl: RELEASE_PUBLICATION_CLAWHUB_REGISTRY,
            fetchImpl: params.fetchImpl,
            requestTimeoutMs: CLAWHUB_OBSERVATION_TIMEOUT_MS,
            sleep: params.sleep,
          })),
    });
    const latest = new Map(
      observations.latestDependencies.map((entry) => [entry.name, entry.version]),
    );
    const npmPublished = new Map(
      observations.npm.map((entry) => [`${entry.name}\0${entry.version}`, entry.published]),
    );
    const clawHubState = new Map(
      observations.clawHub.map((entry) => [
        `${entry.name}\0${entry.version}`,
        {
          packageExists: entry.packageExists,
          hasTrustedPublisher: entry.hasTrustedPublisher,
          alreadyPublished: entry.alreadyPublished,
        },
      ]),
    );
    const resolveLatestVersion: NpmLatestVersionResolver = (packageName) => {
      const version = latest.get(packageName);
      if (!version) {
        throw new Error(`missing npm latest observation for ${packageName}`);
      }
      return version;
    };
    const resolvePublishedVersion: NpmPublishedVersionResolver = (packageName, version) => {
      const published = npmPublished.get(`${packageName}\0${version}`);
      if (published === undefined) {
        throw new Error(`missing npm publication observation for ${packageName}@${version}`);
      }
      return published;
    };
    const npmPluginPlan = collectPluginReleasePlan({
      rootDir,
      selectionMode: "all-publishable",
      resolveLatestVersion,
      resolvePublishedVersion,
    });
    const clawHubPluginPlan = await collectPluginClawHubReleasePlan({
      rootDir,
      selectionMode: "all-publishable",
      registryBaseUrl: RELEASE_PUBLICATION_CLAWHUB_REGISTRY,
      resolveLatestVersion,
      resolvePackageState: async (plugin) => {
        const state = clawHubState.get(`${plugin.packageName}\0${plugin.version}`);
        if (!state) {
          throw new Error(
            `missing ClawHub publication observation for ${plugin.packageName}@${plugin.version}`,
          );
        }
        return state;
      },
    });
    if (!samePackages(npmPluginPlan.all.map(packageIdentity), npmPlugins.map(packageIdentity))) {
      throw new Error("npm plugin publication plan drifted while collecting eligibility");
    }
    if (!samePackages(clawHubPluginPlan.all.map(packageIdentity), clawHubPackages)) {
      throw new Error("ClawHub publication plan drifted while collecting eligibility");
    }
    if (
      clawHubPluginPlan.bootstrapCandidates.length > 0 ||
      clawHubPluginPlan.missingTrustedPublisher.length > 0
    ) {
      throw new Error(
        `ClawHub publication is not ready: bootstrap=${clawHubPluginPlan.bootstrapCandidates.length} missingTrustedPublisher=${clawHubPluginPlan.missingTrustedPublisher.length}`,
      );
    }

    const completedAt = now();
    if (completedAt > startedAt + RELEASE_PUBLICATION_ELIGIBILITY_MAX_AGE_MS) {
      throw new Error("release publication eligibility exceeded five minutes; recollect");
    }
    const receipt = createReleasePublicationEligibilityReceipt({
      schema: "openclaw.release-publication-eligibility.v1",
      release_plan_digest: lock.digest,
      started_at: new Date(startedAt).toISOString(),
      completed_at: new Date(completedAt).toISOString(),
      expires_at: new Date(startedAt + RELEASE_PUBLICATION_ELIGIBILITY_MAX_AGE_MS).toISOString(),
      registries: {
        clawhub: RELEASE_PUBLICATION_CLAWHUB_REGISTRY,
        npm: RELEASE_PUBLICATION_NPM_REGISTRY,
      },
      observations: {
        latest_dependencies: sortPackages(observations.latestDependencies),
        npm: sortPackages(observations.npm),
        clawhub: sortPackages(
          observations.clawHub.map(
            ({ name, version, packageExists, hasTrustedPublisher, alreadyPublished }) => ({
              name,
              version,
              package_exists: packageExists,
              trusted_publisher: hasTrustedPublisher,
              published: alreadyPublished,
            }),
          ),
        ),
      },
      plans: {
        npm: sortPackages(
          observations.npm.map(({ name, version, published }) => ({
            name,
            version,
            action: published ? "skip-published" : "publish",
          })),
        ),
        clawhub: sortPackages(
          observations.clawHub.map(({ name, version, alreadyPublished }) => ({
            name,
            version,
            action: alreadyPublished ? "skip-published" : "publish",
          })),
        ),
      },
    });
    verifyReleasePublicationEligibilityReceipt(receipt, lock, completedAt);
    writeReceipt(params.receiptPath, receipt);
    return receipt;
  } finally {
    rmSync(npmRoot, { force: true, recursive: true });
  }
}
