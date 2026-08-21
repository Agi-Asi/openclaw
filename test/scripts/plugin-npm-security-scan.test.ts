import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertCanonicalNpmPackageName,
  assertCompleteScannerSummary,
  buildPluginNpmSecurityScanReport,
  collectNpmPackedFiles,
  constrainPluginNpmSecurityScanReport,
  listPluginNpmSecurityArtifacts,
  listPublishablePluginPackages,
  normalizePackedFindingPath,
  parsePacklistFiles,
  resolveReviewedSourceLayout,
  scanPublishablePluginPackages,
  stageScannerRelevantPackedFiles,
  stageScannerRelevantPluginTarballFiles,
  type PublishablePluginPackage,
  type ScanPackageResult,
} from "../../scripts/lib/plugin-npm-security-scan.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const CANDIDATE_SHA = "1".repeat(40);
const TOOLING_SHA = "2".repeat(40);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function initGitRepo(root: string): void {
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", root, "config", "user.name", "OpenClaw Test"]);
}

function writePublishableManifest(
  root: string,
  extensionId: string,
  packageName: string,
  extra: Record<string, unknown> = {},
): void {
  const packageDir = join(root, "extensions", extensionId);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, "package.json"),
    `${JSON.stringify({
      name: packageName,
      openclaw: { release: { publishToNpm: true } },
      version: "1.0.0",
      ...extra,
    })}\n`,
    "utf8",
  );
  execFileSync("git", ["-C", root, "add", `extensions/${extensionId}/package.json`]);
}

function writePluginArtifact(params: {
  extensionId: string;
  files: Record<string, string | Buffer>;
  packageName: string;
  version?: string;
}) {
  const root = tempDirs.make("openclaw-plugin-npm-security-artifact-");
  const packageRoot = join(root, "source");
  const artifactDir = join(root, "artifacts", params.extensionId);
  const packageVersion = params.version ?? "1.0.0";
  mkdirSync(packageRoot, { recursive: true });
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    `${JSON.stringify({ name: params.packageName, version: packageVersion })}\n`,
    "utf8",
  );
  writeFileSync(
    join(packageRoot, "openclaw.plugin.json"),
    `${JSON.stringify({ id: params.extensionId })}\n`,
    "utf8",
  );
  for (const [relativePath, content] of Object.entries(params.files)) {
    const filePath = join(packageRoot, relativePath);
    mkdirSync(join(filePath, ".."), { recursive: true });
    writeFileSync(filePath, content);
  }
  const packOutput = execFileSync(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", artifactDir],
    { cwd: packageRoot, encoding: "utf8" },
  );
  const packEntries = JSON.parse(packOutput) as Array<{ filename?: unknown }>;
  const tarballName = packEntries[0]?.filename;
  if (typeof tarballName !== "string") {
    throw new Error("npm pack fixture did not return a tarball filename");
  }
  const tarballPath = join(artifactDir, tarballName);
  const tarballSha256 = createHash("sha256").update(readFileSync(tarballPath)).digest("hex");
  writeFileSync(
    join(artifactDir, "plugin-npm-security-artifact.json"),
    `${JSON.stringify({
      artifactKind: "inert-package-input",
      candidateSha: CANDIDATE_SHA,
      extensionId: params.extensionId,
      packageDir: `extensions/${params.extensionId}`,
      packageName: params.packageName,
      packageVersion,
      schemaVersion: 1,
      tarballName,
      tarballSha256,
      toolingSha: TOOLING_SHA,
    })}\n`,
    "utf8",
  );
  return {
    artifact: {
      artifactKind: "inert-package-input" as const,
      artifactDir,
      candidateSha: CANDIDATE_SHA,
      extensionId: params.extensionId,
      packageDir: `extensions/${params.extensionId}`,
      packageName: params.packageName,
      packageVersion,
      tarballPath,
      tarballSha256,
      toolingSha: TOOLING_SHA,
    },
    artifactRoot: join(root, "artifacts"),
    expectedPackage: {
      extensionId: params.extensionId,
      packageDir: `extensions/${params.extensionId}`,
      packageName: params.packageName,
      packageVersion,
    } satisfies PublishablePluginPackage,
    packageRoot,
    tarballPath,
  };
}

function currentLayoutFindings(): string[] {
  return [
    "@openclaw/codex:dangerous-exec:src/app-server/sandbox-exec-server/sandbox-child.ts",
    "@openclaw/codex:dangerous-exec:src/app-server/transport-process-containment.ts",
    ...Array.from(
      { length: 13 },
      () => "@openclaw/codex:dangerous-exec:src/app-server/transport.process.test.ts",
    ),
  ];
}

function syntheticResult(
  packageName: string,
  overrides: Partial<ScanPackageResult> = {},
): ScanPackageResult {
  return {
    expectedReviewedCriticalFindings: [],
    packageName,
    packageVersion: "1.0.0",
    packedFileCount: 1,
    reviewedCriticalFindings: [],
    scanFindingCount: 0,
    tarballSha256: "a".repeat(64),
    unexpectedCriticalFindings: [],
    ...overrides,
  };
}

describe("scripts/lib/plugin-npm-security-scan.mts", () => {
  it("accepts only the complete current and frozen-legacy source layouts", () => {
    const current = currentLayoutFindings();
    const frozenLegacy = [
      "@openclaw/codex:dangerous-exec:src/app-server/sandbox-exec-server/http.ts",
      "@openclaw/codex:dangerous-exec:src/app-server/sandbox-exec-server/processes.ts",
      "@openclaw/codex:dangerous-exec:src/node-cli-sessions.ts",
      "@openclaw/opencode-provider:dangerous-exec:session-catalog.ts",
      "@openclaw/opencode-provider:dangerous-exec:session-catalog.test.ts",
    ];

    expect(resolveReviewedSourceLayout(current)?.id).toBe("current");
    expect(resolveReviewedSourceLayout(frozenLegacy)?.id).toBe("frozen-legacy");
    expect(resolveReviewedSourceLayout(frozenLegacy.slice(0, -1))).toBeUndefined();
    expect(resolveReviewedSourceLayout([...current, frozenLegacy[0]!])).toBeUndefined();
    expect(resolveReviewedSourceLayout([...current, current[0]!])).toBeUndefined();
  });

  it("collects package files without running lifecycle or candidate replacement helpers", async () => {
    const packageDir = tempDirs.make("openclaw-plugin-npm-security-pack-");
    const replacementMarker = join(packageDir, "replacement-helper-ran");
    const lifecycleMarkers = ["prepare", "prepack", "postpack"].map((name) =>
      join(packageDir, `${name}-ran`),
    );
    writeFileSync(
      join(packageDir, "package.json"),
      `${JSON.stringify({
        name: "@openclaw/test-inert-package",
        scripts: Object.fromEntries(
          ["prepare", "prepack", "postpack"].map((name, index) => [
            name,
            `node -e "require('node:fs').writeFileSync(${JSON.stringify(lifecycleMarkers[index])}, 'ran')"`,
          ]),
        ),
        version: "1.0.0",
      })}\n`,
      "utf8",
    );
    writeFileSync(join(packageDir, "index.js"), "export const value = 1;\n", "utf8");
    writeFileSync(
      join(packageDir, "plugin-npm-pack-files.mjs"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(replacementMarker)}, "ran");\n`,
      "utf8",
    );

    const trustedHelper = join(tempDirs.make("openclaw-plugin-npm-security-helper-"), "helper.mjs");
    writeFileSync(
      trustedHelper,
      'process.stdout.write(JSON.stringify(["index.js", "package.json", "plugin-npm-pack-files.mjs"]));\n',
      "utf8",
    );
    const packedFiles = await collectNpmPackedFiles(packageDir, "@openclaw/test-inert-package", {
      helperPath: trustedHelper,
    });

    expect(packedFiles).toContain("index.js");
    expect(packedFiles).toContain("package.json");
    expect(existsSync(replacementMarker)).toBe(false);
    for (const marker of lifecycleMarkers) {
      expect(existsSync(marker)).toBe(false);
    }
  });

  it("packs candidate input without running lifecycle or asset build hooks", () => {
    const candidateRoot = tempDirs.make("openclaw-plugin-security-inert-pack-");
    const outputDir = tempDirs.make("openclaw-plugin-security-inert-output-");
    const packageDir = join(candidateRoot, "extensions", "inert");
    const packlistHelper = join(candidateRoot, "trusted-packlist-helper.mjs");
    const markers = Object.fromEntries(
      ["asset", "prepare", "prepack", "postpack"].map((name) => [
        name,
        join(candidateRoot, `${name}-ran`),
      ]),
    );
    initGitRepo(candidateRoot);
    mkdirSync(packageDir, { recursive: true });
    const markerCommand = (marker: string) =>
      `node -e "require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')"`;
    writeFileSync(
      join(packageDir, "package.json"),
      `${JSON.stringify({
        name: "@openclaw/test-inert-pack",
        openclaw: {
          assetScripts: { build: markerCommand(markers.asset!) },
          release: { publishToNpm: true },
        },
        scripts: {
          postpack: markerCommand(markers.postpack!),
          prepack: markerCommand(markers.prepack!),
          prepare: markerCommand(markers.prepare!),
        },
        version: "1.0.0",
      })}\n`,
      "utf8",
    );
    writeFileSync(join(packageDir, "index.ts"), "export const inert = true;\n", "utf8");
    writeFileSync(
      join(packageDir, "openclaw.plugin.json"),
      `${JSON.stringify({ id: "inert" })}\n`,
      "utf8",
    );
    writeFileSync(
      packlistHelper,
      'process.stdout.write(JSON.stringify(["index.ts", "openclaw.plugin.json", "package.json"]));\n',
      "utf8",
    );
    execFileSync("git", ["-C", candidateRoot, "add", "."]);
    execFileSync("git", ["-C", candidateRoot, "commit", "--quiet", "-m", "fixture"]);
    const candidateSha = execFileSync("git", ["-C", candidateRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const toolingSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/plugin-npm-security-prepare.mts",
        "prepare",
        "--candidate-root",
        candidateRoot,
        "--candidate-sha",
        candidateSha,
        "--extension-id",
        "inert",
        "--output-dir",
        outputDir,
        "--package-dir",
        "extensions/inert",
        "--package-name",
        "@openclaw/test-inert-pack",
        "--tooling-sha",
        toolingSha,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_ENV: "test",
          OPENCLAW_PLUGIN_SECURITY_TEST_PACKLIST_HELPER: packlistHelper,
        },
      },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    for (const marker of Object.values(markers)) {
      expect(existsSync(marker)).toBe(false);
    }
    const metadata = JSON.parse(
      readFileSync(join(outputDir, "plugin-npm-security-artifact.json"), "utf8"),
    ) as { artifactKind?: unknown; tarballName?: unknown };
    expect(metadata.artifactKind).toBe("inert-package-input");
    expect(typeof metadata.tarballName).toBe("string");
    const staged = stageScannerRelevantPluginTarballFiles(
      join(outputDir, String(metadata.tarballName)),
    );
    try {
      expect(staged.packedFiles).toContain("index.ts");
      expect(staged.packedFiles.some((file) => file.startsWith("dist/"))).toBe(false);
    } finally {
      rmSync(staged.stageDir, { force: true, recursive: true });
    }
  });

  it("rejects malformed, unsafe, duplicate, and excessive packlist entries", () => {
    for (const malformed of [
      null,
      {},
      1,
      "",
      "/absolute.js",
      "dir\\file.js",
      "../escape.js",
      ".hidden.js",
      "node_modules/dependency.js",
      "a".repeat(4097),
    ]) {
      expect(() =>
        parsePacklistFiles(JSON.stringify(["valid.js", malformed]), "@openclaw/test"),
      ).toThrow("entry 1 has an invalid path");
    }
    expect(() =>
      parsePacklistFiles(JSON.stringify(["index.js", "index.js"]), "@openclaw/test"),
    ).toThrow("duplicate path");
    expect(() =>
      parsePacklistFiles(
        JSON.stringify(Array.from({ length: 20_001 }, (_, index) => `file-${index}.js`)),
        "@openclaw/test",
      ),
    ).toThrow("file-count limit");
  });

  it("preserves bounded packlist helper failure categories", async () => {
    const root = tempDirs.make("openclaw-plugin-packlist-helper-limits-");
    const packageDir = tempDirs.make("openclaw-plugin-packlist-helper-package-");
    const timeoutHelper = join(root, "timeout.mjs");
    const failedHelper = join(root, "failed.mjs");
    writeFileSync(timeoutHelper, "setInterval(() => {}, 1_000);\n", "utf8");
    writeFileSync(failedHelper, "process.exit(7);\n", "utf8");

    await expect(
      collectNpmPackedFiles(packageDir, "@openclaw/test-timeout", {
        helperPath: timeoutHelper,
        timeoutMs: 25,
      }),
    ).rejects.toThrow("trusted packlist helper timed out");
    await expect(
      collectNpmPackedFiles(packageDir, "@openclaw/test-failed", {
        helperPath: failedHelper,
      }),
    ).rejects.toThrow("trusted packlist helper failed");
  });

  it("bounds manifests and rejects noncanonical or duplicate package identities", async () => {
    expect(() => assertCanonicalNpmPackageName("OpenClaw/Bad", "fixture")).toThrow(
      "invalid npm package name",
    );

    const duplicateRoot = tempDirs.make("openclaw-plugin-npm-security-duplicates-");
    initGitRepo(duplicateRoot);
    writePublishableManifest(duplicateRoot, "one", "@openclaw/duplicate");
    writePublishableManifest(duplicateRoot, "two", "@openclaw/duplicate");
    await expect(listPublishablePluginPackages(duplicateRoot)).rejects.toThrow(
      "duplicate publishable package",
    );
    await expect(
      listPublishablePluginPackages(duplicateRoot, { maxPackageManifests: 1 }),
    ).rejects.toThrow("package-count limit");

    const manifestRoot = tempDirs.make("openclaw-plugin-npm-security-manifest-");
    initGitRepo(manifestRoot);
    writePublishableManifest(manifestRoot, "large", "@openclaw/large", {
      description: "x".repeat(1024),
    });
    await expect(
      listPublishablePluginPackages(manifestRoot, { maxManifestBytes: 256 }),
    ).rejects.toThrow("manifest exceeds the byte limit");
  });

  it("fails closed on truncated scans, source escapes, and tarball symlinks", () => {
    expect(() => assertCompleteScannerSummary("@openclaw/test", { truncated: true })).toThrow(
      "security scan reached its file limit",
    );
    expect(() =>
      stageScannerRelevantPackedFiles(tempDirs.make("openclaw-plugin-npm-security-path-"), [
        "../escape.ts",
      ]),
    ).toThrow("npm pack returned an unsafe path");

    const packageDir = tempDirs.make("openclaw-plugin-npm-security-symlink-");
    const outsideDir = tempDirs.make("openclaw-plugin-npm-security-outside-");
    const outsideFile = join(outsideDir, "outside.ts");
    writeFileSync(outsideFile, "export const value = 1;\n", "utf8");
    symlinkSync(outsideFile, join(packageDir, "escape.ts"));
    expect(() => stageScannerRelevantPackedFiles(packageDir, ["escape.ts"])).toThrow(
      "not a regular file",
    );

    const artifact = writePluginArtifact({
      extensionId: "symlink",
      files: { "index.js": "export const value = 1;\n" },
      packageName: "@openclaw/test-symlink",
    });
    symlinkSync(outsideFile, join(artifact.packageRoot, "escape.ts"));
    execFileSync(
      "tar",
      ["-czf", artifact.tarballPath, "-C", join(artifact.packageRoot, ".."), "source"],
      { env: { ...process.env, COPYFILE_DISABLE: "1" } },
    );
    expect(() => stageScannerRelevantPluginTarballFiles(artifact.tarballPath)).toThrow();
  });

  it("accounts for all packed bytes and scans only exact bundler hash filenames", () => {
    const artifact = writePluginArtifact({
      extensionId: "packed",
      files: {
        "asset.bin": Buffer.alloc(128),
        "dist/service-BaCqPs_5.js": "export const value = 1;\n",
        "dist/service-malware.js": "export const value = 2;\n",
      },
      packageName: "@openclaw/test-packed",
    });
    const staged = stageScannerRelevantPluginTarballFiles(artifact.tarballPath);
    try {
      expect(staged.inspection.inventory.map((entry) => entry.path)).toContain("package/asset.bin");
      expect(staged.packedFiles).toContain("asset.bin");
    } finally {
      rmSync(staged.stageDir, { force: true, recursive: true });
    }
    expect(normalizePackedFindingPath("dist/service-BaCqPs_5.js")).toBe("dist/service-<hash>.js");
    expect(normalizePackedFindingPath("dist/service-malware.js")).toBe("dist/service-malware.js");
  });

  it("finds malicious packed input code, ignores candidate scanner replacements, and fails slow", async () => {
    const marker = join(tempDirs.make("openclaw-plugin-npm-security-marker-"), "ran");
    const malicious = writePluginArtifact({
      extensionId: "malicious",
      files: {
        "index.js": `const { execSync } = require("node:child_process");\nexecSync("id");\n`,
        "scripts/plugin-npm-security-scan.mts": `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`,
      },
      packageName: "@openclaw/test-malicious",
    });
    const oversized = writePluginArtifact({
      extensionId: "oversized",
      files: { "oversized.js": Buffer.alloc(1024 * 1024 + 1) },
      packageName: "@openclaw/test-oversized",
    });

    const { packageResults, scanErrors } = await scanPublishablePluginPackages([
      oversized.artifact,
      malicious.artifact,
    ]);

    expect(existsSync(marker)).toBe(false);
    expect(packageResults).toHaveLength(1);
    expect(packageResults[0]?.unexpectedCriticalFindings).toContainEqual({
      line: 2,
      path: "index.js",
      ruleId: "dangerous-exec",
    });
    expect(scanErrors).toHaveLength(1);
    expect(scanErrors[0]).toContain("@openclaw/test-oversized");
    expect(scanErrors[0]).not.toContain(oversized.artifact.tarballPath);

    const report = buildPluginNpmSecurityScanReport({
      candidateSha: CANDIDATE_SHA,
      packageResults,
      scanErrors,
      toolingSha: TOOLING_SHA,
    });
    expect(report.status).toBe("fail");
    expect(report.errors).toContainEqual(expect.stringContaining("unexpected critical findings"));
    expect(report.errors).toContainEqual(expect.stringContaining("package scan failed"));
    expect(JSON.stringify(report)).not.toContain("execSync");
  });

  it("validates immutable artifact identity and exact package plans", () => {
    const artifact = writePluginArtifact({
      extensionId: "identity",
      files: { "index.js": "export const value = 1;\n" },
      packageName: "@openclaw/test-identity",
    });
    expect(
      listPluginNpmSecurityArtifacts({
        artifactRoot: artifact.artifactRoot,
        candidateSha: CANDIDATE_SHA,
        expectedPackages: [artifact.expectedPackage],
        toolingSha: TOOLING_SHA,
      }).map((entry) => entry.packageName),
    ).toEqual(["@openclaw/test-identity"]);
    expect(() =>
      listPluginNpmSecurityArtifacts({
        artifactRoot: artifact.artifactRoot,
        candidateSha: CANDIDATE_SHA,
        expectedPackages: [],
        toolingSha: TOOLING_SHA,
      }),
    ).toThrow("does not match the trusted package plan");
  });

  it("caps total findings and emits byte-identical bounded reports", () => {
    const packageResults = [
      syntheticResult("@openclaw/codex", {
        reviewedCriticalFindings: currentLayoutFindings(),
        scanFindingCount: 51,
      }),
    ];
    const report = buildPluginNpmSecurityScanReport({
      candidateSha: CANDIDATE_SHA,
      maxTotalFindings: 50,
      packageResults,
      toolingSha: TOOLING_SHA,
    });
    expect(report.errors).toContain(
      "Plugin npm security scan exceeded the total finding-count limit.",
    );
    expect(JSON.stringify(report)).toBe(
      JSON.stringify(
        buildPluginNpmSecurityScanReport({
          candidateSha: CANDIDATE_SHA,
          maxTotalFindings: 50,
          packageResults: structuredClone(packageResults).reverse(),
          toolingSha: TOOLING_SHA,
        }),
      ),
    );
    expect(constrainPluginNpmSecurityScanReport(report, 64).errors).toEqual([
      "Plugin npm security scan report exceeded the byte limit.",
    ]);
  });

  it("writes sanitized exact-identity reports when the bounded scanner times out or OOMs", () => {
    const root = tempDirs.make("openclaw-plugin-npm-security-runner-");
    const timeoutChild = join(root, "timeout.mjs");
    const oomChild = join(root, "oom.mjs");
    writeFileSync(timeoutChild, "await new Promise(() => {});\n", "utf8");
    writeFileSync(
      oomChild,
      "const values = [];\nwhile (true) values.push(new Array(100000).fill(Math.random()));\n",
      "utf8",
    );
    for (const [label, child, timeoutMs] of [
      ["timeout", timeoutChild, "25"],
      ["oom", oomChild, "10000"],
    ] as const) {
      const reportPath = join(root, `${label}.json`);
      const result = spawnSync(
        process.execPath,
        [
          "scripts/plugin-npm-security-scan-runner.mjs",
          "--artifact-root",
          join(root, "artifacts"),
          "--candidate-sha",
          CANDIDATE_SHA,
          "--expected-packages-json",
          "[]",
          "--tooling-sha",
          TOOLING_SHA,
          "--report",
          reportPath,
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            NODE_ENV: "test",
            OPENCLAW_PLUGIN_SECURITY_RUNNER_CHILD: child,
            OPENCLAW_PLUGIN_SECURITY_RUNNER_HEAP_MB: "16",
            OPENCLAW_PLUGIN_SECURITY_RUNNER_TIMEOUT_MS: timeoutMs,
          },
          timeout: 15_000,
        },
      );
      const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
        candidateSha: string;
        toolingSha: string;
      };
      expect(result.status).toBe(1);
      expect(report).toMatchObject({
        candidateSha: CANDIDATE_SHA,
        toolingSha: TOOLING_SHA,
      });
      expect(`${result.stdout}${result.stderr}${JSON.stringify(report)}`).not.toContain(root);
    }
  }, 30_000);

  it("retains the complete current-root publishable plugin inventory contract", async () => {
    const packages = await listPublishablePluginPackages(process.cwd());
    expect(packages.length).toBeGreaterThan(0);
    expect(packages.map((plugin) => plugin.packageName)).toContain("@openclaw/acpx");
    expect(new Set(packages.map((plugin) => plugin.packageName)).size).toBe(packages.length);
    expect(packages).toEqual(
      packages.toSorted((left, right) =>
        left.packageName < right.packageName ? -1 : left.packageName > right.packageName ? 1 : 0,
      ),
    );
  });
});
