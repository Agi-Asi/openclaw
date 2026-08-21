import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createReleasePlanLock,
  type ReleasePlanLock,
} from "../../scripts/release-plan-contract.mjs";
import {
  parseReleasePublicationEligibilityReceiptJson,
  RELEASE_PUBLICATION_CLAWHUB_REGISTRY,
  RELEASE_PUBLICATION_ELIGIBILITY_MAX_AGE_MS,
  RELEASE_PUBLICATION_NPM_REGISTRY,
} from "../../scripts/release-publication-eligibility-contract.mjs";
import {
  collectReleasePublicationEligibility,
  collectReleasePublicationObservations,
  publicNpmObservationCommand,
  retryNpmObservation,
} from "../../scripts/release-publication-eligibility.mts";
import { writePublishablePluginFixture } from "../helpers/publishable-plugin-fixture.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { writeJsonFile } from "../helpers/temp-repo.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const releasePlanLockFixture = JSON.parse(
  readFileSync(resolve("test/fixtures/release-plan-lock-v1.compatibility.json"), "utf8"),
) as ReleasePlanLock;

function makeRepo() {
  const rootDir = tempDirs.make("openclaw-release-publication-eligibility-");
  execFileSync("git", ["init", "-q"], { cwd: rootDir });
  writeJsonFile(join(rootDir, "package.json"), {
    name: "openclaw",
    version: "2026.8.1-beta.2",
  });
  writePublishablePluginFixture(rootDir, {
    extensionId: "example",
    packageName: "@openclaw/example",
    version: "2026.8.1-beta.2",
    publishTo: "both",
    dependency: {
      packageName: "@openai/codex",
      version: "0.149.0",
      requireLatest: true,
    },
  });
  execFileSync("git", ["add", "."], { cwd: rootDir });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=OpenClaw Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-q",
      "-m",
      "candidate",
    ],
    { cwd: rootDir },
  );
  const candidateSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: rootDir,
    encoding: "utf8",
  }).trim();
  return {
    rootDir,
    releasePlanLock: createReleasePlanLock({
      ...releasePlanLockFixture.plan,
      candidate_sha: candidateSha,
    }),
  };
}

function readyClawHubFetch(): typeof fetch {
  return vi.fn(async (input) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const pathname = new URL(raw).pathname;
    if (pathname.endsWith("/trusted-publisher")) {
      return new Response(
        JSON.stringify({
          trustedPublisher: {
            repository: "openclaw/openclaw",
            workflowFilename: "plugin-clawhub-release.yml",
          },
        }),
        { status: 200 },
      );
    }
    if (pathname.includes("/versions/")) {
      return new Response("", { status: 404 });
    }
    return new Response("{}", { status: 200 });
  });
}

describe("release publication eligibility collection", () => {
  it("collects every ReleasePlan npm and ClawHub package into a canonical receipt", async () => {
    const { releasePlanLock, rootDir } = makeRepo();
    const receiptPath = join(rootDir, "receipt.json");
    const latest = vi.fn(async () => "0.149.0");
    const npmPublished = vi.fn(async (name: string) => name === "openclaw");
    const fetchImpl = readyClawHubFetch();
    const receipt = await collectReleasePublicationEligibility({
      rootDir,
      receiptPath,
      releasePlanLock,
      fetchImpl,
      resolveLatestVersion: latest,
      resolveNpmPublishedVersion: npmPublished,
      now: () => Date.parse("2026-08-21T00:00:00.000Z"),
    });

    expect(latest).toHaveBeenCalledTimes(1);
    expect(npmPublished).toHaveBeenCalledTimes(2);
    expect(receipt.plans.npm).toEqual([
      { name: "@openclaw/example", version: "2026.8.1-beta.2", action: "publish" },
      { name: "openclaw", version: "2026.8.1-beta.2", action: "skip-published" },
    ]);
    expect(receipt.plans.clawhub).toEqual([
      { name: "@openclaw/example", version: "2026.8.1-beta.2", action: "publish" },
    ]);
    expect(
      parseReleasePublicationEligibilityReceiptJson(readFileSync(receiptPath, "utf8")),
    ).toEqual(receipt);
    for (const [input] of vi.mocked(fetchImpl).mock.calls) {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      expect(raw.startsWith(`${RELEASE_PUBLICATION_CLAWHUB_REGISTRY}/`)).toBe(true);
    }
  });

  it("uses one global eight-slot pool and deduplicates latest dependency reads", async () => {
    let active = 0;
    let maxActive = 0;
    const run = async <T>(value: T) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolvePromise) => {
        setTimeout(resolvePromise, 5);
      });
      active -= 1;
      return value;
    };
    const clawHubPlugins = Array.from({ length: 6 }, (_, index) => ({
      extensionId: `plugin-${index}`,
      packageDir: `extensions/plugin-${index}`,
      packageName: `@openclaw/plugin-${index}`,
      version: "2026.8.1-beta.2",
      channel: "beta" as const,
      publishTag: "beta" as const,
    }));
    const latest = vi.fn(async () => await run("1.0.0"));
    const observations = await collectReleasePublicationObservations({
      latestDependencyNames: ["dep-a", "dep-a", "dep-b", "dep-c"],
      npmPackages: Array.from({ length: 6 }, (_, index) => ({
        name: `@openclaw/npm-${index}`,
        version: "2026.8.1-beta.2",
      })),
      clawHubPlugins,
      resolveLatestVersion: latest,
      resolveNpmPublishedVersion: async () => await run(false),
      resolveClawHubState: async () =>
        await run({
          packageExists: true,
          hasTrustedPublisher: true,
          alreadyPublished: false,
        }),
    });

    expect(latest).toHaveBeenCalledTimes(3);
    expect(observations.npm).toHaveLength(6);
    expect(observations.clawHub).toHaveLength(6);
    expect(maxActive).toBe(8);
  });

  it("drains independent failures, reports all of them, and emits no receipt", async () => {
    const { releasePlanLock, rootDir } = makeRepo();
    const receiptPath = join(rootDir, "receipt.json");
    const npmPublished = vi.fn(async (name: string) => {
      throw new Error(`npm unavailable for ${name}`);
    });
    const clawHubState = vi.fn(async () => {
      throw new Error("ClawHub unavailable");
    });

    await expect(
      collectReleasePublicationEligibility({
        rootDir,
        receiptPath,
        releasePlanLock,
        resolveLatestVersion: async () => "0.149.0",
        resolveNpmPublishedVersion: npmPublished,
        resolveClawHubState: clawHubState,
      }),
    ).rejects.toThrow("observation failures (3)");
    expect(npmPublished).toHaveBeenCalledTimes(2);
    expect(clawHubState).toHaveBeenCalledTimes(1);
    expect(() => readFileSync(receiptPath)).toThrow();
  });

  it("refuses to collect from a checkout other than the ReleasePlan candidate", async () => {
    const { releasePlanLock, rootDir } = makeRepo();
    const receiptPath = join(rootDir, "receipt.json");
    writeJsonFile(receiptPath, { stale: true });
    const differentCandidate = createReleasePlanLock({
      ...releasePlanLock.plan,
      candidate_sha: "c".repeat(40),
    });

    await expect(
      collectReleasePublicationEligibility({
        rootDir,
        receiptPath,
        releasePlanLock: differentCandidate,
      }),
    ).rejects.toThrow("does not match ReleasePlan candidate");
    expect(() => readFileSync(receiptPath)).toThrow();
  });

  it("fails closed on stale dependencies, missing ClawHub trust, and elapsed freshness", async () => {
    const { releasePlanLock, rootDir } = makeRepo();
    const receiptPath = join(rootDir, "receipt.json");
    await expect(
      collectReleasePublicationEligibility({
        rootDir,
        receiptPath,
        releasePlanLock,
        resolveLatestVersion: async () => "0.150.0",
        resolveNpmPublishedVersion: async () => false,
        resolveClawHubState: async () => ({
          packageExists: true,
          hasTrustedPublisher: true,
          alreadyPublished: false,
        }),
      }),
    ).rejects.toThrow("must match npm latest for release");
    await expect(
      collectReleasePublicationEligibility({
        rootDir,
        receiptPath,
        releasePlanLock,
        resolveLatestVersion: async () => "0.149.0",
        resolveNpmPublishedVersion: async () => false,
        resolveClawHubState: async () => ({
          packageExists: true,
          hasTrustedPublisher: false,
          alreadyPublished: false,
        }),
      }),
    ).rejects.toThrow("missingTrustedPublisher=1");
    const times = [0, RELEASE_PUBLICATION_ELIGIBILITY_MAX_AGE_MS + 1];
    await expect(
      collectReleasePublicationEligibility({
        rootDir,
        receiptPath,
        releasePlanLock,
        resolveLatestVersion: async () => "0.149.0",
        resolveNpmPublishedVersion: async () => false,
        resolveClawHubState: async () => ({
          packageExists: true,
          hasTrustedPublisher: true,
          alreadyPublished: false,
        }),
        now: () => times.shift() ?? RELEASE_PUBLICATION_ELIGIBILITY_MAX_AGE_MS + 1,
      }),
    ).rejects.toThrow("exceeded five minutes");
    expect(() => readFileSync(receiptPath)).toThrow();
  });

  it("forces public npm registry configuration and bounds transient retries", async () => {
    const previousRegistry = process.env.NPM_CONFIG_REGISTRY;
    process.env.NPM_CONFIG_REGISTRY = "https://npm.invalid";
    try {
      const command = publicNpmObservationCommand(["openclaw", "version"], "/tmp/empty-npmrc");
      expect(command.args).toContain(RELEASE_PUBLICATION_NPM_REGISTRY);
      expect(command.env.NPM_CONFIG_REGISTRY).toBe(RELEASE_PUBLICATION_NPM_REGISTRY);
      expect(command.env.npm_config_registry).toBe(RELEASE_PUBLICATION_NPM_REGISTRY);
    } finally {
      if (previousRegistry === undefined) {
        delete process.env.NPM_CONFIG_REGISTRY;
      } else {
        process.env.NPM_CONFIG_REGISTRY = previousRegistry;
      }
    }

    const sleep = vi.fn(async () => undefined);
    const succeeds = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }))
      .mockRejectedValueOnce(Object.assign(new Error("reset"), { code: "ECONNRESET" }))
      .mockResolvedValue("ok");
    await expect(retryNpmObservation(succeeds, sleep)).resolves.toBe("ok");
    expect(succeeds).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 1_000);
    expect(sleep).toHaveBeenNthCalledWith(2, 2_000);
  });
});
