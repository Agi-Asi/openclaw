import { execFile } from "node:child_process";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  isScannable,
  scanDirectoryWithSummary,
  type SkillScanFinding,
} from "../../src/skills/security/scanner.js";
import { runTasksWithConcurrency } from "../../src/utils/run-with-concurrency.js";
import {
  inspectPackageTarballBytes,
  readBoundedRegularFile,
} from "../plugin-publication-artifact.mjs";

export type PublishablePluginPackage = {
  extensionId: string;
  packageDir: string;
  packageName: string;
  packageVersion: string;
};

type CriticalFindingRecord = {
  line: number;
  path: string;
  ruleId: string;
};

export type ScanPackageResult = {
  expectedReviewedCriticalFindings: string[];
  packageName: string;
  packageVersion: string;
  packedFileCount: number;
  reviewedCriticalFindings: string[];
  scanFindingCount: number;
  tarballSha256: string;
  unexpectedCriticalFindings: CriticalFindingRecord[];
};

type PluginNpmSecurityArtifact = PublishablePluginPackage & {
  artifactDir: string;
  candidateSha: string;
  tarballPath: string;
  tarballSha256: string;
  toolingSha: string;
};

export type PluginNpmSecurityScanReport = {
  candidateSha: string;
  errors: string[];
  layout: string | null;
  packages: ScanPackageResult[];
  schemaVersion: 1;
  status: "pass" | "fail";
  summary: {
    findingCount: number;
    packageCount: number;
    reviewedCriticalFindingCount: number;
    unexpectedCriticalFindingCount: number;
  };
  toolingSha: string;
};

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const validateNpmPackageName = require("validate-npm-package-name") as (name: unknown) => {
  validForNewPackages: boolean;
};
export const MAX_PUBLISHABLE_PLUGIN_PACKAGES = 256;
export const MAX_PLUGIN_PACKAGE_MANIFEST_BYTES = 256 * 1024;
export const MAX_PLUGIN_SCAN_FINDINGS_PER_PACKAGE = 10_000;
export const MAX_PLUGIN_SCAN_TOTAL_FINDINGS = 50_000;
export const MAX_PLUGIN_SCAN_REPORT_BYTES = 1024 * 1024;
const MAX_PLUGIN_SECURITY_ARTIFACT_METADATA_BYTES = 64 * 1024;
const MAX_PLUGIN_TARBALL_BYTES = 128 * 1024 * 1024;
const MAX_PACKED_FILES_PER_PACKAGE = 20_000;
const MAX_PACKED_FILE_BYTES = 64 * 1024 * 1024;
const MAX_PACKED_TOTAL_BYTES_PER_PACKAGE = 256 * 1024 * 1024;
const MAX_SCANNABLE_FILES_PER_PACKAGE = 10_000;
const MAX_SCANNABLE_FILE_BYTES = 1024 * 1024;
const MAX_SCANNABLE_TOTAL_BYTES_PER_PACKAGE = 64 * 1024 * 1024;
const MAX_PACKED_PATH_BYTES = 4096;
const PACKLIST_HELPER_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const PACKLIST_HELPER_MAX_OLD_SPACE_MB = 256;
const PACKLIST_HELPER_TIMEOUT_MS = 60_000;
const PACKAGE_SCAN_CONCURRENCY = 4;
const PACKLIST_HELPER_PATH = fileURLToPath(new URL("./plugin-npm-pack-files.mjs", import.meta.url));
const DEFAULT_SCANNER_INPUT_LIMITS = {
  maxPackedFileBytes: MAX_PACKED_FILE_BYTES,
  maxPackedFiles: MAX_PACKED_FILES_PER_PACKAGE,
  maxPackedTotalBytes: MAX_PACKED_TOTAL_BYTES_PER_PACKAGE,
  maxFileBytes: MAX_SCANNABLE_FILE_BYTES,
  maxFiles: MAX_SCANNABLE_FILES_PER_PACKAGE,
  maxTotalBytes: MAX_SCANNABLE_TOTAL_BYTES_PER_PACKAGE,
};

const COMMON_REVIEWED_CRITICAL_FINDING_COUNTS = new Map<string, number>([
  ["@openclaw/acpx:dangerous-exec:src/codex-auth-bridge.ts", 1],
  ["@openclaw/acpx:dangerous-exec:src/runtime-internals/mcp-proxy.mjs", 1],
  ["@openclaw/acpx:dangerous-exec:src/runtime-internals/mcp-proxy.test.ts", 3],
  ["@openclaw/codex:dangerous-exec:src/app-server/transport-stdio.ts", 1],
  ["@openclaw/codex:dangerous-exec:src/doctor.ts", 1],
  ["@openclaw/discord:dangerous-exec:src/voice/audio.ts", 1],
  ["@openclaw/imessage:dangerous-exec:src/client.ts", 1],
  ["@openclaw/imessage:dangerous-exec:src/client.test.ts", 3],
  ["@openclaw/llama-cpp-provider:dangerous-exec:src/llama-server-install.ts", 1],
  ["@openclaw/mxc-sandbox:dangerous-exec:src/readiness.ts", 2],
  ["@openclaw/raft:dangerous-exec:src/gateway.ts", 1],
  ["@openclaw/signal:dangerous-exec:src/daemon.ts", 1],
  ["@openclaw/voice-call:dangerous-exec:src/tunnel.ts", 1],
  ["@openclaw/diagnostics-prometheus:dangerous-exec:src/install-runtime.e2e.test.ts", 2],
  ["@openclaw/google-meet:dangerous-exec:src/cli-artifacts.test.ts", 1],
  ["@openclaw/google-meet:dangerous-exec:src/realtime.process.test.ts", 1],
  ["@openclaw/memory-lancedb:dangerous-exec:memory-lancedb.concurrent.test.ts", 1],
  ["@openclaw/opencode-go-provider:env-harvesting:opencode-go.live.test.ts", 1],
  ["@openclaw/openshell-sandbox:dangerous-exec:src/backend.e2e.test.ts", 1],
  ["@openclaw/openshell-sandbox:dangerous-exec:src/openshell-core.test.ts", 1],
]);

const REVIEWED_RELEASE_LAYOUTS = Object.freeze([
  {
    id: "frozen-legacy",
    findings: new Map<string, number>([
      ["@openclaw/codex:dangerous-exec:src/app-server/sandbox-exec-server/http.ts", 1],
      ["@openclaw/codex:dangerous-exec:src/app-server/sandbox-exec-server/processes.ts", 1],
      ["@openclaw/codex:dangerous-exec:src/node-cli-sessions.ts", 1],
      ["@openclaw/opencode-provider:dangerous-exec:session-catalog.ts", 1],
      ["@openclaw/opencode-provider:dangerous-exec:session-catalog.test.ts", 1],
    ]),
  },
  {
    id: "current",
    findings: new Map<string, number>([
      ["@openclaw/codex:dangerous-exec:src/app-server/sandbox-exec-server/sandbox-child.ts", 1],
      ["@openclaw/codex:dangerous-exec:src/app-server/transport-process-containment.ts", 1],
      ["@openclaw/codex:dangerous-exec:src/app-server/transport.process.test.ts", 13],
    ]),
  },
]);

// Generated chunks can contain multiple reviewed execution sites. Counts are
// part of the contract so an added or missing site fails the release scan.
const OPTIONAL_REVIEWED_DIST_CRITICAL_FINDING_COUNTS = new Map<string, number>([
  ["@openclaw/acpx:dangerous-exec:dist/mcp-proxy.mjs", 1],
  ["@openclaw/acpx:dangerous-exec:dist/service-<hash>.js", 1],
  ["@openclaw/codex:dangerous-exec:dist/api.js", 1],
  ["@openclaw/codex:dangerous-exec:dist/dynamic-tools-<hash>.js", 2],
  ["@openclaw/codex:dangerous-exec:dist/session-catalog-<hash>.js", 1],
  ["@openclaw/codex:dangerous-exec:dist/transport-stdio-<hash>.js", 1],
  ["@openclaw/llama-cpp-provider:dangerous-exec:dist/index.js", 1],
  ["@openclaw/slack:dynamic-code-execution:dist/outbound-payload.test-harness-<hash>.js", 1],
  ["@openclaw/voice-call:dangerous-exec:dist/runtime-entry-<hash>.js", 1],
]);

const REVIEWED_LAYOUT_FINDING_COUNTS = new Map<string, number>(
  REVIEWED_RELEASE_LAYOUTS.flatMap((layout) => [...layout.findings]),
);

function expandFindingCounts(counts: ReadonlyMap<string, number>): string[] {
  return [...counts].flatMap(([key, count]) => Array.from({ length: count }, () => key));
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortStrings(values: readonly string[]): string[] {
  return [...values].toSorted(compareCodeUnits);
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function resolveReviewedSourceLayout(
  reviewedCriticalFindings: readonly string[],
): (typeof REVIEWED_RELEASE_LAYOUTS)[number] | undefined {
  const observedLayoutFindings = sortStrings(
    reviewedCriticalFindings.filter((key) => REVIEWED_LAYOUT_FINDING_COUNTS.has(key)),
  );
  return REVIEWED_RELEASE_LAYOUTS.find((layout) =>
    arraysEqual(observedLayoutFindings, sortStrings(expandFindingCounts(layout.findings))),
  );
}

export function parsePacklistFiles(raw: string, packageName: string): string[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`${packageName}: packlist helper did not return a files list.`);
  }

  if (parsed.length > MAX_PACKED_FILES_PER_PACKAGE) {
    throw new Error(`${packageName}: packlist exceeds the file-count limit.`);
  }

  const packedPaths: string[] = [];
  const seenPaths = new Set<string>();
  for (const [index, packedPath] of parsed.entries()) {
    if (
      typeof packedPath !== "string" ||
      !isSafePackedPath(packedPath) ||
      Buffer.byteLength(packedPath, "utf8") > MAX_PACKED_PATH_BYTES
    ) {
      throw new Error(`${packageName}: packlist entry ${index} has an invalid path.`);
    }
    if (seenPaths.has(packedPath)) {
      throw new Error(`${packageName}: packlist returned a duplicate path: ${packedPath}`);
    }
    seenPaths.add(packedPath);
    packedPaths.push(packedPath);
  }
  return packedPaths.toSorted();
}

type PacklistHelperLimits = {
  helperPath?: string;
  maxBufferBytes?: number;
  maxOldSpaceMb?: number;
  timeoutMs?: number;
};

export async function collectNpmPackedFiles(
  packageDir: string,
  packageName: string,
  limits: PacklistHelperLimits = {},
): Promise<string[]> {
  const helperPath = limits.helperPath ?? PACKLIST_HELPER_PATH;
  const maxOldSpaceMb = limits.maxOldSpaceMb ?? PACKLIST_HELPER_MAX_OLD_SPACE_MB;
  const timeoutMs = limits.timeoutMs ?? PACKLIST_HELPER_TIMEOUT_MS;
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [`--max-old-space-size=${maxOldSpaceMb}`, helperPath, packageDir],
      {
        cwd: dirname(PACKLIST_HELPER_PATH),
        encoding: "utf8",
        env: {
          CI: "1",
          HOME: tmpdir(),
          PATH: process.env.PATH,
        },
        killSignal: "SIGKILL",
        maxBuffer: limits.maxBufferBytes ?? PACKLIST_HELPER_MAX_BUFFER_BYTES,
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    return parsePacklistFiles(stdout, packageName);
  } catch (error) {
    const failure =
      error && typeof error === "object"
        ? (error as { code?: unknown; killed?: unknown; signal?: unknown })
        : {};
    if (failure.code === "ABORT_ERR" || failure.code === "ETIMEDOUT") {
      throw new Error(`${packageName}: trusted packlist helper timed out.`);
    }
    if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw new Error(`${packageName}: trusted packlist helper exceeded its output limit.`);
    }
    if (failure.killed === true || typeof failure.signal === "string") {
      throw new Error(`${packageName}: trusted packlist helper exceeded its process limit.`);
    }
    if (typeof failure.code === "number") {
      throw new Error(`${packageName}: trusted packlist helper failed.`);
    }
    throw new Error(`${packageName}: trusted packlist helper could not start.`);
  }
}

export function normalizePackedFindingPath(packedPath: string): string {
  for (const prefix of [
    "dynamic-tools",
    "outbound-payload.test-harness",
    "run-attempt",
    "runtime-entry",
    "service",
    "session-catalog",
    "transport-stdio",
  ]) {
    if (new RegExp(`^dist/${prefix}-[A-Za-z0-9_-]{8}\\.js$`, "u").test(packedPath)) {
      return `dist/${prefix}-<hash>.js`;
    }
  }
  return packedPath;
}

function expectedOptionalReviewedFindingsForPackedPath(
  packageName: string,
  packedPath: string,
): string[] {
  const normalizedPath = normalizePackedFindingPath(packedPath);
  const keyPrefix = `${packageName}:`;
  const keySuffix = `:${normalizedPath}`;
  return [...OPTIONAL_REVIEWED_DIST_CRITICAL_FINDING_COUNTS].flatMap(([key, count]) =>
    key.startsWith(keyPrefix) && key.endsWith(keySuffix)
      ? Array.from({ length: count }, () => key)
      : [],
  );
}

function isReviewedCriticalFinding(key: string): boolean {
  return (
    COMMON_REVIEWED_CRITICAL_FINDING_COUNTS.has(key) ||
    REVIEWED_LAYOUT_FINDING_COUNTS.has(key) ||
    OPTIONAL_REVIEWED_DIST_CRITICAL_FINDING_COUNTS.has(key)
  );
}

function isSafePackedPath(packedPath: string): boolean {
  if (
    !packedPath ||
    isAbsolute(packedPath) ||
    packedPath.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(packedPath) ||
    packedPath.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return false;
  }
  return !packedPath.split("/").some((segment) => {
    return segment === "node_modules" || segment.startsWith(".");
  });
}

function assertPathInside(parentPath: string, childPath: string): void {
  const relativePath = relative(parentPath, childPath);
  if (relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== "..")) {
    return;
  }
  throw new Error(`Packed file escaped its plugin package: ${relativePath}`);
}

export function stageScannerRelevantPackedFiles(
  packageDir: string,
  packedFiles: readonly string[],
  limits = DEFAULT_SCANNER_INPUT_LIMITS,
): {
  fileCount: number;
  packedFileCount: number;
  packedTotalBytes: number;
  stageDir: string;
  totalBytes: number;
} {
  const stageDir = mkdtempSync(join(tmpdir(), "openclaw-plugin-npm-scan-"));
  const realPackageDir = realpathSync(packageDir);
  let fileCount = 0;
  let packedFileCount = 0;
  let packedTotalBytes = 0;
  let totalBytes = 0;

  try {
    for (const packedPath of packedFiles) {
      if (!isSafePackedPath(packedPath)) {
        throw new Error(`npm pack returned an unsafe path: ${packedPath}`);
      }
      const source = resolve(realPackageDir, packedPath);
      const sourceStat = lstatSync(source);
      if (!sourceStat.isFile()) {
        throw new Error(`Packed scanner input is not a regular file: ${packedPath}`);
      }
      packedFileCount += 1;
      packedTotalBytes += sourceStat.size;
      if (sourceStat.size > limits.maxPackedFileBytes) {
        throw new Error(`Packed input exceeds the per-file byte limit: ${packedPath}`);
      }
      if (packedFileCount > limits.maxPackedFiles) {
        throw new Error("Packed input exceeds the file-count limit.");
      }
      if (packedTotalBytes > limits.maxPackedTotalBytes) {
        throw new Error("Packed input exceeds the total-byte limit.");
      }

      const realSource = realpathSync(source);
      assertPathInside(realPackageDir, realSource);
      if (!isScannable(packedPath)) {
        continue;
      }
      if (sourceStat.size > limits.maxFileBytes) {
        throw new Error(`Packed scanner input exceeds the per-file byte limit: ${packedPath}`);
      }
      fileCount += 1;
      totalBytes += sourceStat.size;
      if (fileCount > limits.maxFiles) {
        throw new Error("Packed scanner input exceeds the file-count limit.");
      }
      if (totalBytes > limits.maxTotalBytes) {
        throw new Error("Packed scanner input exceeds the total-byte limit.");
      }
      const target = join(stageDir, ...packedPath.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(realSource, target);
    }
    return { fileCount, packedFileCount, packedTotalBytes, stageDir, totalBytes };
  } catch (error) {
    rmSync(stageDir, { recursive: true, force: true });
    throw error;
  }
}

async function gitOutput(rootDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

export function assertCanonicalNpmPackageName(packageName: unknown, label: string): string {
  if (
    typeof packageName !== "string" ||
    packageName.trim() !== packageName ||
    !validateNpmPackageName(packageName).validForNewPackages
  ) {
    throw new Error(`${label}: publishable plugin has an invalid npm package name.`);
  }
  return packageName;
}

export async function listPublishablePluginPackages(
  candidateDir: string,
  limits: {
    maxManifestBytes?: number;
    maxPackageManifests?: number;
  } = {},
): Promise<PublishablePluginPackage[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", candidateDir, "ls-files", "-z", "--", ":(glob)extensions/*/package.json"],
    {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const packageFiles = stdout.split("\0").filter(Boolean).toSorted();
  const maxPackageManifests = limits.maxPackageManifests ?? MAX_PUBLISHABLE_PLUGIN_PACKAGES;
  if (packageFiles.length > maxPackageManifests) {
    throw new Error("Candidate exceeds the plugin package-count limit.");
  }

  const publishablePackages = packageFiles.flatMap((packageFile) => {
    const match = /^extensions\/([^/]+)\/package\.json$/u.exec(packageFile);
    if (!match?.[1]) {
      return [];
    }
    const packageDir = resolve(candidateDir, "extensions", match[1]);
    const packageJsonPath = join(packageDir, "package.json");
    const packageStat = lstatSync(packageJsonPath);
    if (!packageStat.isFile()) {
      throw new Error(`${packageFile}: package manifest is not a regular file.`);
    }
    if (
      packageStat.size === 0 ||
      packageStat.size > (limits.maxManifestBytes ?? MAX_PLUGIN_PACKAGE_MANIFEST_BYTES)
    ) {
      throw new Error(`${packageFile}: package manifest exceeds the byte limit.`);
    }
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      name?: unknown;
      version?: unknown;
      openclaw?: { release?: { publishToNpm?: unknown } };
    };
    if (packageJson.openclaw?.release?.publishToNpm !== true) {
      return [];
    }
    const packageName = assertCanonicalNpmPackageName(packageJson.name, packageFile);
    if (
      typeof packageJson.version !== "string" ||
      !packageJson.version ||
      packageJson.version.trim() !== packageJson.version
    ) {
      throw new Error(`${packageFile}: publishable plugin has an invalid package version.`);
    }
    return [
      {
        extensionId: match[1],
        packageDir,
        packageName,
        packageVersion: packageJson.version,
      },
    ];
  });
  const seenNames = new Set<string>();
  for (const plugin of publishablePackages) {
    if (seenNames.has(plugin.packageName)) {
      throw new Error(`Candidate contains duplicate publishable package ${plugin.packageName}.`);
    }
    seenNames.add(plugin.packageName);
  }
  return publishablePackages.toSorted((left, right) =>
    compareCodeUnits(left.packageName, right.packageName),
  );
}

const PLUGIN_SECURITY_ARTIFACT_METADATA = "plugin-npm-security-artifact.json";

function parseExpectedPackages(value: unknown): PublishablePluginPackage[] {
  if (!Array.isArray(value) || value.length > MAX_PUBLISHABLE_PLUGIN_PACKAGES) {
    throw new Error("Expected plugin package inventory is invalid.");
  }
  const packages = value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Expected plugin package entry ${index} is invalid.`);
    }
    const candidate = entry as Record<string, unknown>;
    const extensionId = candidate.extensionId;
    const packageDir = candidate.packageDir;
    const packageName = assertCanonicalNpmPackageName(
      candidate.packageName,
      `Expected plugin package entry ${index}`,
    );
    const packageVersion = candidate.packageVersion;
    if (
      typeof extensionId !== "string" ||
      !/^[a-z0-9][a-z0-9._-]*$/u.test(extensionId) ||
      packageDir !== `extensions/${extensionId}` ||
      typeof packageVersion !== "string" ||
      !packageVersion ||
      packageVersion.trim() !== packageVersion
    ) {
      throw new Error(`Expected plugin package entry ${index} is invalid.`);
    }
    return { extensionId, packageDir, packageName, packageVersion };
  });
  const sorted = packages.toSorted((left, right) =>
    compareCodeUnits(left.packageName, right.packageName),
  );
  if (
    new Set(sorted.map((plugin) => plugin.packageName)).size !== sorted.length ||
    new Set(sorted.map((plugin) => plugin.extensionId)).size !== sorted.length ||
    JSON.stringify(sorted) !== JSON.stringify(packages)
  ) {
    throw new Error("Expected plugin package inventory must be unique and sorted.");
  }
  return sorted;
}

function readPluginSecurityArtifact(
  artifactDir: string,
  expectedCandidateSha: string,
  expectedToolingSha: string,
): PluginNpmSecurityArtifact {
  const metadataPath = join(artifactDir, PLUGIN_SECURITY_ARTIFACT_METADATA);
  const metadataStat = lstatSync(metadataPath);
  if (
    !metadataStat.isFile() ||
    metadataStat.size === 0 ||
    metadataStat.size > MAX_PLUGIN_SECURITY_ARTIFACT_METADATA_BYTES
  ) {
    throw new Error("Plugin security artifact metadata is outside the byte limit.");
  }
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
  const expectedKeys = [
    "candidateSha",
    "extensionId",
    "packageDir",
    "packageName",
    "packageVersion",
    "schemaVersion",
    "tarballName",
    "tarballSha256",
    "toolingSha",
  ];
  if (
    metadata.schemaVersion !== 1 ||
    JSON.stringify(Object.keys(metadata).toSorted()) !== JSON.stringify(expectedKeys)
  ) {
    throw new Error("Plugin security artifact metadata has an invalid shape.");
  }
  const packageName = assertCanonicalNpmPackageName(
    metadata.packageName,
    "Plugin security artifact metadata",
  );
  const extensionId = metadata.extensionId;
  const packageDir = metadata.packageDir;
  const packageVersion = metadata.packageVersion;
  const tarballName = metadata.tarballName;
  const tarballSha256 = metadata.tarballSha256;
  if (
    metadata.candidateSha !== expectedCandidateSha ||
    metadata.toolingSha !== expectedToolingSha ||
    typeof extensionId !== "string" ||
    !/^[a-z0-9][a-z0-9._-]*$/u.test(extensionId) ||
    packageDir !== `extensions/${extensionId}` ||
    typeof packageVersion !== "string" ||
    !packageVersion ||
    packageVersion.trim() !== packageVersion ||
    typeof tarballName !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/u.test(tarballName) ||
    basename(tarballName) !== tarballName ||
    typeof tarballSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(tarballSha256)
  ) {
    throw new Error("Plugin security artifact metadata identity is invalid.");
  }
  const artifactEntries = readdirSync(artifactDir, { withFileTypes: true });
  if (
    artifactEntries.length !== 2 ||
    artifactEntries.some(
      (entry) =>
        !entry.isFile() ||
        (entry.name !== PLUGIN_SECURITY_ARTIFACT_METADATA && entry.name !== tarballName),
    )
  ) {
    throw new Error("Plugin security artifact contains unexpected entries.");
  }
  const tarballPath = join(artifactDir, tarballName);
  const tarballStat = lstatSync(tarballPath);
  if (
    !tarballStat.isFile() ||
    tarballStat.size === 0 ||
    tarballStat.size > MAX_PLUGIN_TARBALL_BYTES
  ) {
    throw new Error(`${packageName}: plugin tarball is outside the byte limit.`);
  }
  return {
    artifactDir,
    candidateSha: expectedCandidateSha,
    extensionId,
    packageDir,
    packageName,
    packageVersion,
    tarballPath,
    tarballSha256,
    toolingSha: expectedToolingSha,
  };
}

export function listPluginNpmSecurityArtifacts(params: {
  artifactRoot: string;
  candidateSha: string;
  expectedPackages: unknown;
  toolingSha: string;
}): PluginNpmSecurityArtifact[] {
  const expectedPackages = parseExpectedPackages(params.expectedPackages);
  const artifactRoot = realpathSync(params.artifactRoot);
  const entries = readdirSync(artifactRoot, { withFileTypes: true }).toSorted((left, right) =>
    compareCodeUnits(left.name, right.name),
  );
  if (entries.length > MAX_PUBLISHABLE_PLUGIN_PACKAGES) {
    throw new Error("Plugin security artifact set exceeds the package-count limit.");
  }
  const artifacts = entries.map((entry) => {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("Plugin security artifact root contains a non-directory entry.");
    }
    return readPluginSecurityArtifact(
      join(artifactRoot, entry.name),
      params.candidateSha,
      params.toolingSha,
    );
  });
  const sorted = artifacts.toSorted((left, right) =>
    compareCodeUnits(left.packageName, right.packageName),
  );
  if (new Set(sorted.map((plugin) => plugin.packageName)).size !== sorted.length) {
    throw new Error("Plugin security artifact set contains duplicate package names.");
  }
  const observedPackages = sorted.map(
    ({ extensionId, packageDir, packageName, packageVersion }) => ({
      extensionId,
      packageDir,
      packageName,
      packageVersion,
    }),
  );
  if (JSON.stringify(observedPackages) !== JSON.stringify(expectedPackages)) {
    throw new Error("Plugin security artifact set does not match the trusted package plan.");
  }
  return sorted;
}

export function stageScannerRelevantPluginTarballFiles(tarballPath: string): {
  fileCount: number;
  inspection: {
    inventory: Array<{ path: string; sizeBytes: number; type: string }>;
    packageManifest: Record<string, unknown>;
    tarballSha256: string;
  };
  packedFiles: string[];
  stageDir: string;
  totalBytes: number;
} {
  const stageDir = mkdtempSync(join(tmpdir(), "openclaw-plugin-npm-scan-"));
  let fileCount = 0;
  let totalBytes = 0;
  const packedFiles: string[] = [];
  try {
    const tarballBytes = readBoundedRegularFile(tarballPath, {
      label: "Plugin security tarball",
      maxBytes: MAX_PLUGIN_TARBALL_BYTES,
    });
    const inspection = inspectPackageTarballBytes(tarballBytes, {
      maxArchiveBytes: MAX_PLUGIN_TARBALL_BYTES,
      maxEntries: MAX_PACKED_FILES_PER_PACKAGE,
      maxEntryBytes: MAX_PACKED_FILE_BYTES,
      maxExpandedBytes: MAX_PACKED_TOTAL_BYTES_PER_PACKAGE,
      maxPathBytes: 4 * 1024 * 1024,
      maxTotalFileBytes: MAX_PACKED_TOTAL_BYTES_PER_PACKAGE,
      onFile: ({ content, path }: { content: Uint8Array; path: string }) => {
        if (!path.startsWith("package/")) {
          throw new Error("Plugin tarball file escaped package/.");
        }
        const packedPath = path.slice("package/".length);
        packedFiles.push(packedPath);
        if (!isScannable(packedPath)) {
          return;
        }
        if (content.byteLength > MAX_SCANNABLE_FILE_BYTES) {
          throw new Error(`Packed scanner input exceeds the per-file byte limit: ${packedPath}`);
        }
        fileCount += 1;
        totalBytes += content.byteLength;
        if (fileCount > MAX_SCANNABLE_FILES_PER_PACKAGE) {
          throw new Error("Packed scanner input exceeds the file-count limit.");
        }
        if (totalBytes > MAX_SCANNABLE_TOTAL_BYTES_PER_PACKAGE) {
          throw new Error("Packed scanner input exceeds the total-byte limit.");
        }
        const target = join(stageDir, ...packedPath.split("/"));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
      },
    }) as {
      inventory: Array<{ path: string; sizeBytes: number; type: string }>;
      packageManifest: Record<string, unknown>;
      tarballSha256: string;
    };
    return {
      fileCount,
      inspection,
      packedFiles: packedFiles.toSorted(),
      stageDir,
      totalBytes,
    };
  } catch (error) {
    rmSync(stageDir, { recursive: true, force: true });
    throw error;
  }
}

function findingRecord(stageDir: string, finding: SkillScanFinding): CriticalFindingRecord {
  const packedPath = normalizePackedFindingPath(
    relative(stageDir, finding.file).split(sep).join("/"),
  );
  return { line: finding.line, path: packedPath, ruleId: finding.ruleId };
}

function findingKey(packageName: string, finding: CriticalFindingRecord): string {
  return `${packageName}:${finding.ruleId}:${finding.path}`;
}

export function assertCompleteScannerSummary(
  packageName: string,
  summary: { truncated: boolean },
): void {
  if (summary.truncated) {
    throw new Error(`${packageName}: security scan reached its file limit.`);
  }
}

async function scanPublishablePluginArtifact(
  plugin: PluginNpmSecurityArtifact,
): Promise<ScanPackageResult> {
  const reviewedCriticalFindings: string[] = [];
  const expectedReviewedCriticalFindings: string[] = [];
  const unexpectedCriticalFindings: CriticalFindingRecord[] = [];
  let scanFindingCount = 0;
  const staged = stageScannerRelevantPluginTarballFiles(plugin.tarballPath);
  try {
    if (
      staged.inspection.packageManifest.name !== plugin.packageName ||
      staged.inspection.packageManifest.version !== plugin.packageVersion ||
      staged.inspection.tarballSha256 !== plugin.tarballSha256
    ) {
      throw new Error(`${plugin.packageName}: immutable plugin tarball identity mismatch.`);
    }
    for (const packedFile of staged.packedFiles) {
      expectedReviewedCriticalFindings.push(
        ...expectedOptionalReviewedFindingsForPackedPath(plugin.packageName, packedFile),
      );
    }
    const summary = await scanDirectoryWithSummary(staged.stageDir, {
      excludeTestFiles: false,
      maxFileBytes: MAX_SCANNABLE_FILE_BYTES,
      maxFiles: MAX_SCANNABLE_FILES_PER_PACKAGE,
    });
    assertCompleteScannerSummary(plugin.packageName, summary);
    if (summary.findings.length > MAX_PLUGIN_SCAN_FINDINGS_PER_PACKAGE) {
      throw new Error(`${plugin.packageName}: security scan exceeded the finding-count limit.`);
    }
    scanFindingCount = summary.findings.length;
    if (summary.scannedFiles !== staged.fileCount) {
      throw new Error(
        `${plugin.packageName}: security scan processed ${summary.scannedFiles} of ${staged.fileCount} staged files.`,
      );
    }
    for (const finding of summary.findings) {
      if (finding.severity !== "critical") {
        continue;
      }
      const record = findingRecord(staged.stageDir, finding);
      const key = findingKey(plugin.packageName, record);
      if (isReviewedCriticalFinding(key)) {
        reviewedCriticalFindings.push(key);
      } else {
        unexpectedCriticalFindings.push(record);
      }
    }
  } finally {
    rmSync(staged.stageDir, { recursive: true, force: true });
  }

  return {
    expectedReviewedCriticalFindings: sortStrings(expectedReviewedCriticalFindings),
    packageName: plugin.packageName,
    packageVersion: plugin.packageVersion,
    packedFileCount: staged.inspection.inventory.filter((entry) => entry.type === "file").length,
    reviewedCriticalFindings: sortStrings(reviewedCriticalFindings),
    scanFindingCount,
    tarballSha256: plugin.tarballSha256,
    unexpectedCriticalFindings: unexpectedCriticalFindings.toSorted((left, right) =>
      compareCodeUnits(JSON.stringify(left), JSON.stringify(right)),
    ),
  };
}

function expectedRequiredFindingsForPackage(
  packageName: string,
  layout: (typeof REVIEWED_RELEASE_LAYOUTS)[number],
): string[] {
  return [...COMMON_REVIEWED_CRITICAL_FINDING_COUNTS, ...layout.findings].flatMap(([key, count]) =>
    key.startsWith(`${packageName}:`) ? Array.from({ length: count }, () => key) : [],
  );
}

export function buildPluginNpmSecurityScanReport(params: {
  candidateSha: string;
  maxTotalFindings?: number;
  packageResults: ScanPackageResult[];
  scanErrors?: readonly string[];
  toolingSha: string;
}): PluginNpmSecurityScanReport {
  const { candidateSha, packageResults, toolingSha } = params;
  const allReviewedFindings = packageResults.flatMap((result) => result.reviewedCriticalFindings);
  const totalFindingCount = packageResults.reduce(
    (total, result) => total + result.scanFindingCount,
    0,
  );
  const layout = resolveReviewedSourceLayout(allReviewedFindings);
  const errors: string[] = sortStrings(params.scanErrors ?? []);

  if (totalFindingCount > (params.maxTotalFindings ?? MAX_PLUGIN_SCAN_TOTAL_FINDINGS)) {
    errors.push("Plugin npm security scan exceeded the total finding-count limit.");
  }
  if (!layout) {
    errors.push("Reviewed critical findings do not match exactly one supported release layout.");
  }
  if (packageResults.length === 0) {
    errors.push("No publishable npm plugins were found in the candidate checkout.");
  }

  const publishablePackageNames = new Set(packageResults.map((result) => result.packageName));
  const requiredFindingCounts = new Map<string, number>([
    ...COMMON_REVIEWED_CRITICAL_FINDING_COUNTS,
    ...(layout?.findings ?? []),
  ]);
  const missingPackages = [
    ...new Set([...requiredFindingCounts.keys()].map((key) => key.slice(0, key.indexOf(":")))),
  ].filter((packageName) => !publishablePackageNames.has(packageName));
  if (missingPackages.length > 0) {
    errors.push(
      `Reviewed inventory references unpublished packages: ${missingPackages.join(", ")}`,
    );
  }

  for (const result of packageResults) {
    if (result.unexpectedCriticalFindings.length > 0) {
      errors.push(
        `${result.packageName}: unexpected critical findings: ${JSON.stringify(result.unexpectedCriticalFindings)}`,
      );
    }
    if (!layout) {
      continue;
    }
    const expected = sortStrings([
      ...expectedRequiredFindingsForPackage(result.packageName, layout),
      ...result.expectedReviewedCriticalFindings,
    ]);
    const observed = sortStrings(result.reviewedCriticalFindings);
    if (!arraysEqual(expected, observed)) {
      errors.push(
        `${result.packageName}: reviewed critical inventory mismatch; expected ${JSON.stringify(expected)}, observed ${JSON.stringify(observed)}`,
      );
    }
  }

  const unexpectedCriticalFindingCount = packageResults.reduce(
    (total, result) => total + result.unexpectedCriticalFindings.length,
    0,
  );
  const sortedPackages = packageResults
    .map((result) => ({
      ...result,
      expectedReviewedCriticalFindings: sortStrings(result.expectedReviewedCriticalFindings),
      reviewedCriticalFindings: sortStrings(result.reviewedCriticalFindings),
      unexpectedCriticalFindings: result.unexpectedCriticalFindings.toSorted((left, right) =>
        compareCodeUnits(JSON.stringify(left), JSON.stringify(right)),
      ),
    }))
    .toSorted((left, right) => compareCodeUnits(left.packageName, right.packageName));
  return {
    candidateSha,
    errors: sortStrings(errors),
    layout: layout?.id ?? null,
    packages: sortedPackages,
    schemaVersion: 1,
    status: errors.length === 0 ? "pass" : "fail",
    summary: {
      findingCount: totalFindingCount,
      packageCount: packageResults.length,
      reviewedCriticalFindingCount: allReviewedFindings.length,
      unexpectedCriticalFindingCount,
    },
    toolingSha,
  };
}

export function constrainPluginNpmSecurityScanReport(
  report: PluginNpmSecurityScanReport,
  maxBytes = MAX_PLUGIN_SCAN_REPORT_BYTES,
): PluginNpmSecurityScanReport {
  const serializedBytes = Buffer.byteLength(`${JSON.stringify(report)}\n`, "utf8");
  if (serializedBytes <= maxBytes) {
    return report;
  }
  return {
    candidateSha: report.candidateSha,
    errors: ["Plugin npm security scan report exceeded the byte limit."],
    layout: null,
    packages: [],
    schemaVersion: 1,
    status: "fail",
    summary: report.summary,
    toolingSha: report.toolingSha,
  };
}

function sanitizePackageScanError(plugin: PluginNpmSecurityArtifact, error: unknown): string {
  let message = error instanceof Error ? error.message : "Unknown package scan failure.";
  for (const [path, replacement] of [
    [plugin.packageDir, "<candidate-package>"],
    [tmpdir(), "<tmp>"],
  ] as const) {
    message = message.replaceAll(path, replacement);
  }
  message = message
    .replaceAll(/\/(?:private\/)?tmp\/openclaw-plugin-npm-scan-[^/\s:]+/gu, "<scanner-stage>")
    .replaceAll(/(^|[\s:(])\/[^ \t\n\r:,)\]}]+/gu, "$1<path>");
  return `${plugin.packageName}: package scan failed: ${message}`;
}

export async function scanPublishablePluginPackages(
  packages: readonly PluginNpmSecurityArtifact[],
): Promise<{ packageResults: ScanPackageResult[]; scanErrors: string[] }> {
  const scanErrors: string[] = [];
  const { results } = await runTasksWithConcurrency({
    errorMode: "continue",
    limit: PACKAGE_SCAN_CONCURRENCY,
    onTaskError: (error, index) => {
      const plugin = packages[index];
      scanErrors.push(
        plugin ? sanitizePackageScanError(plugin, error) : "Unknown package: package scan failed.",
      );
    },
    tasks: packages.map((plugin) => () => scanPublishablePluginArtifact(plugin)),
  });
  return {
    packageResults: results.filter((result): result is ScanPackageResult => result !== undefined),
    scanErrors: sortStrings(scanErrors),
  };
}

export async function runPluginNpmSecurityScan(params: {
  artifactRoot: string;
  candidateSha: string;
  expectedPackages: unknown;
  toolingDir: string;
  toolingSha: string;
}): Promise<PluginNpmSecurityScanReport> {
  const toolingDir = realpathSync(params.toolingDir);
  const toolingSha = await gitOutput(toolingDir, ["rev-parse", "HEAD"]);
  if (toolingSha !== params.toolingSha) {
    throw new Error("Trusted scanner tooling checkout differs from the expected commit.");
  }
  const packages = listPluginNpmSecurityArtifacts({
    artifactRoot: params.artifactRoot,
    candidateSha: params.candidateSha,
    expectedPackages: params.expectedPackages,
    toolingSha,
  });
  const { packageResults, scanErrors } = await scanPublishablePluginPackages(packages);
  return constrainPluginNpmSecurityScanReport(
    buildPluginNpmSecurityScanReport({
      candidateSha: params.candidateSha,
      packageResults,
      scanErrors,
      toolingSha,
    }),
  );
}
