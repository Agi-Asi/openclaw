import { execFile } from "node:child_process";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { resolveNpmJsonEntries } from "../../src/infra/npm-registry-spec.js";
import {
  isScannable,
  scanDirectoryWithSummary,
  type SkillScanFinding,
} from "../../src/skills/security/scanner.js";
import { runTasksWithConcurrency } from "../../src/utils/run-with-concurrency.js";

type NpmPackFile = {
  path?: unknown;
  size?: unknown;
};

type NpmPackResult = {
  files?: unknown;
};

type PublishablePluginPackage = {
  packageDir: string;
  packageName: string;
};

type CriticalFindingRecord = {
  line: number;
  path: string;
  ruleId: string;
};

type ScanPackageResult = {
  expectedReviewedCriticalFindings: string[];
  packageName: string;
  packedFileCount: number;
  reviewedCriticalFindings: string[];
  unexpectedCriticalFindings: CriticalFindingRecord[];
};

export type PluginNpmSecurityScanReport = {
  candidateSha: string;
  errors: string[];
  layout: string | null;
  packages: ScanPackageResult[];
  schemaVersion: 1;
  status: "pass" | "fail";
  summary: {
    packageCount: number;
    reviewedCriticalFindingCount: number;
    unexpectedCriticalFindingCount: number;
  };
  toolingSha: string;
};

const execFileAsync = promisify(execFile);
const MAX_PACKED_FILES_PER_PACKAGE = 20_000;
const MAX_PACKED_FILE_BYTES = 64 * 1024 * 1024;
const MAX_PACKED_TOTAL_BYTES_PER_PACKAGE = 256 * 1024 * 1024;
const MAX_SCANNABLE_FILES_PER_PACKAGE = 10_000;
const MAX_SCANNABLE_FILE_BYTES = 1024 * 1024;
const MAX_SCANNABLE_TOTAL_BYTES_PER_PACKAGE = 64 * 1024 * 1024;
const NPM_PACK_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const NPM_PACK_TIMEOUT_MS = 60_000;
const PACKAGE_SCAN_CONCURRENCY = 4;
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

function sortStrings(values: readonly string[]): string[] {
  return [...values].toSorted((left, right) => left.localeCompare(right));
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

export function parseNpmPackFiles(raw: string, packageName: string): string[] {
  const parsed = JSON.parse(raw) as unknown;
  const entries = resolveNpmJsonEntries(parsed);
  if (entries.length !== 1) {
    throw new Error(`${packageName}: npm pack --dry-run did not return one package result.`);
  }

  const result = entries[0] as NpmPackResult;
  if (!Array.isArray(result.files)) {
    throw new Error(`${packageName}: npm pack --dry-run did not return a files list.`);
  }

  if (result.files.length > MAX_PACKED_FILES_PER_PACKAGE) {
    throw new Error(`${packageName}: npm pack files exceed the file-count limit.`);
  }

  const packedPaths: string[] = [];
  const seenPaths = new Set<string>();
  let totalBytes = 0;
  for (const [index, entry] of result.files.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${packageName}: npm pack file entry ${index} is malformed.`);
    }
    const { path, size } = entry as NpmPackFile;
    if (typeof path !== "string" || !path) {
      throw new Error(`${packageName}: npm pack file entry ${index} has an invalid path.`);
    }
    if (!Number.isSafeInteger(size) || (size as number) < 0) {
      throw new Error(`${packageName}: npm pack file entry ${index} has an invalid size.`);
    }
    if (seenPaths.has(path)) {
      throw new Error(`${packageName}: npm pack returned a duplicate path: ${path}`);
    }
    if ((size as number) > MAX_PACKED_FILE_BYTES) {
      throw new Error(`${packageName}: npm pack file exceeds the per-file byte limit: ${path}`);
    }
    seenPaths.add(path);
    packedPaths.push(path);
    totalBytes += size as number;
    if (totalBytes > MAX_PACKED_TOTAL_BYTES_PER_PACKAGE) {
      throw new Error(`${packageName}: npm pack files exceed the total-byte limit.`);
    }
  }
  return packedPaths.toSorted();
}

export async function collectNpmPackedFiles(
  packageDir: string,
  packageName: string,
): Promise<string[]> {
  const npmArgs = ["pack", "--dry-run", "--json", "--ignore-scripts"];
  // The release workflow is Linux: cap npm before it can materialize an
  // attacker-controlled pack. Other hosts retain the Node/output/time caps.
  const command =
    process.platform === "linux"
      ? {
          args: [
            "--as=1073741824",
            "--cpu=60",
            "--fsize=268435456",
            "--nofile=256",
            "--",
            "npm",
            ...npmArgs,
          ],
          file: "prlimit",
        }
      : { args: npmArgs, file: "npm" };
  try {
    const { stdout } = await execFileAsync(command.file, command.args, {
      cwd: packageDir,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: "--max-old-space-size=512",
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_ignore_scripts: "true",
        npm_config_update_notifier: "false",
      },
      killSignal: "SIGKILL",
      maxBuffer: NPM_PACK_MAX_BUFFER_BYTES,
      timeout: NPM_PACK_TIMEOUT_MS,
    });
    return parseNpmPackFiles(stdout, packageName);
  } catch {
    throw new Error(`${packageName}: npm pack enumeration failed within its resource limits.`);
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

async function listPublishablePluginPackages(
  candidateDir: string,
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

  return packageFiles.flatMap((packageFile) => {
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
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      name?: unknown;
      openclaw?: { release?: { publishToNpm?: unknown } };
    };
    if (packageJson.openclaw?.release?.publishToNpm !== true) {
      return [];
    }
    if (typeof packageJson.name !== "string" || !packageJson.name.trim()) {
      throw new Error(`${packageFile}: publishable plugin is missing its package name.`);
    }
    return [{ packageDir, packageName: packageJson.name }];
  });
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

async function scanPublishablePluginPackage(
  plugin: PublishablePluginPackage,
): Promise<ScanPackageResult> {
  const reviewedCriticalFindings: string[] = [];
  const expectedReviewedCriticalFindings: string[] = [];
  const unexpectedCriticalFindings: CriticalFindingRecord[] = [];
  const packedFiles = await collectNpmPackedFiles(plugin.packageDir, plugin.packageName);
  for (const packedFile of packedFiles) {
    expectedReviewedCriticalFindings.push(
      ...expectedOptionalReviewedFindingsForPackedPath(plugin.packageName, packedFile),
    );
  }

  const staged = stageScannerRelevantPackedFiles(plugin.packageDir, packedFiles);
  try {
    const summary = await scanDirectoryWithSummary(staged.stageDir, {
      excludeTestFiles: false,
      maxFileBytes: MAX_SCANNABLE_FILE_BYTES,
      maxFiles: MAX_SCANNABLE_FILES_PER_PACKAGE,
    });
    assertCompleteScannerSummary(plugin.packageName, summary);
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
    packedFileCount: staged.packedFileCount,
    reviewedCriticalFindings: sortStrings(reviewedCriticalFindings),
    unexpectedCriticalFindings: unexpectedCriticalFindings.toSorted((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
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
  packageResults: ScanPackageResult[];
  scanErrors?: readonly string[];
  toolingSha: string;
}): PluginNpmSecurityScanReport {
  const { candidateSha, packageResults, toolingSha } = params;
  const allReviewedFindings = packageResults.flatMap((result) => result.reviewedCriticalFindings);
  const layout = resolveReviewedSourceLayout(allReviewedFindings);
  const errors: string[] = sortStrings(params.scanErrors ?? []);

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
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      ),
    }))
    .toSorted((left, right) => left.packageName.localeCompare(right.packageName));
  return {
    candidateSha,
    errors: sortStrings(errors),
    layout: layout?.id ?? null,
    packages: sortedPackages,
    schemaVersion: 1,
    status: errors.length === 0 ? "pass" : "fail",
    summary: {
      packageCount: packageResults.length,
      reviewedCriticalFindingCount: allReviewedFindings.length,
      unexpectedCriticalFindingCount,
    },
    toolingSha,
  };
}

function sanitizePackageScanError(plugin: PublishablePluginPackage, error: unknown): string {
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
  packages: readonly PublishablePluginPackage[],
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
    tasks: packages.map((plugin) => () => scanPublishablePluginPackage(plugin)),
  });
  return {
    packageResults: results.filter((result): result is ScanPackageResult => result !== undefined),
    scanErrors: sortStrings(scanErrors),
  };
}

export async function runPluginNpmSecurityScan(params: {
  candidateDir: string;
  toolingDir: string;
}): Promise<PluginNpmSecurityScanReport> {
  const candidateDir = realpathSync(params.candidateDir);
  const toolingDir = realpathSync(params.toolingDir);
  const [candidateSha, toolingSha, packages] = await Promise.all([
    gitOutput(candidateDir, ["rev-parse", "HEAD"]),
    gitOutput(toolingDir, ["rev-parse", "HEAD"]),
    listPublishablePluginPackages(candidateDir),
  ]);
  const { packageResults, scanErrors } = await scanPublishablePluginPackages(packages);
  return buildPluginNpmSecurityScanReport({
    candidateSha,
    packageResults,
    scanErrors,
    toolingSha,
  });
}
