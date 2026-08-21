import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertCompleteScannerSummary,
  buildPluginNpmSecurityScanReport,
  collectNpmPackedFiles,
  normalizePackedFindingPath,
  parseNpmPackFiles,
  resolveReviewedSourceLayout,
  runPluginNpmSecurityScan,
  scanPublishablePluginPackages,
  stageScannerRelevantPackedFiles,
} from "../../scripts/lib/plugin-npm-security-scan.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("scripts/lib/plugin-npm-security-scan.mts", () => {
  it("accepts only the complete current and frozen-legacy source layouts", () => {
    const current = [
      "@openclaw/codex:dangerous-exec:src/app-server/sandbox-exec-server/sandbox-child.ts",
      "@openclaw/codex:dangerous-exec:src/app-server/transport-process-containment.ts",
      ...Array.from(
        { length: 13 },
        () => "@openclaw/codex:dangerous-exec:src/app-server/transport.process.test.ts",
      ),
    ];
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

  it("collects candidate package files without running lifecycle scripts", async () => {
    const packageDir = tempDirs.make("openclaw-plugin-npm-security-pack-");
    const lifecycleMarker = join(packageDir, "prepack-ran");
    writeFileSync(
      join(packageDir, "package.json"),
      `${JSON.stringify(
        {
          name: "@openclaw/test-inert-package",
          version: "1.0.0",
          scripts: {
            prepack: `node -e "require('node:fs').writeFileSync(${JSON.stringify(
              lifecycleMarker,
            )}, 'ran')"`,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    writeFileSync(join(packageDir, "index.js"), "export const value = 1;\n", "utf8");

    const packedFiles = await collectNpmPackedFiles(packageDir, "@openclaw/test-inert-package");

    expect(packedFiles).toContain("index.js");
    expect(packedFiles).toContain("package.json");
    expect(existsSync(lifecycleMarker)).toBe(false);
  });

  it("rejects malformed and duplicate npm pack file entries", () => {
    for (const malformed of [
      null,
      {},
      { path: 1, size: 1 },
      { path: "", size: 1 },
      { path: "index.js", size: -1 },
    ]) {
      expect(() =>
        parseNpmPackFiles(
          JSON.stringify([{ files: [{ path: "valid.js", size: 1 }, malformed] }]),
          "@openclaw/test",
        ),
      ).toThrow(/entry 1 (?:has an invalid (?:path|size)|is malformed)/u);
    }
    expect(() =>
      parseNpmPackFiles(
        JSON.stringify([
          {
            files: [
              { path: "index.js", size: 1 },
              { path: "index.js", size: 1 },
            ],
          },
        ]),
        "@openclaw/test",
      ),
    ).toThrow("duplicate path");
  });

  it("fails closed on truncated scans and packed-file path escapes", () => {
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

    const oversizeDir = tempDirs.make("openclaw-plugin-npm-security-oversize-");
    writeFileSync(join(oversizeDir, "oversize.ts"), Buffer.alloc(1024 * 1024 + 1));
    expect(() => stageScannerRelevantPackedFiles(oversizeDir, ["oversize.ts"])).toThrow(
      "per-file byte limit",
    );

    const boundedDir = tempDirs.make("openclaw-plugin-npm-security-bounds-");
    writeFileSync(join(boundedDir, "one.ts"), "1", "utf8");
    writeFileSync(join(boundedDir, "two.ts"), "22", "utf8");
    expect(() =>
      stageScannerRelevantPackedFiles(boundedDir, ["one.ts", "two.ts"], {
        maxPackedFileBytes: 10,
        maxPackedFiles: 10,
        maxPackedTotalBytes: 10,
        maxFileBytes: 10,
        maxFiles: 1,
        maxTotalBytes: 10,
      }),
    ).toThrow("file-count limit");
    expect(() =>
      stageScannerRelevantPackedFiles(boundedDir, ["two.ts"], {
        maxPackedFileBytes: 10,
        maxPackedFiles: 10,
        maxPackedTotalBytes: 10,
        maxFileBytes: 10,
        maxFiles: 10,
        maxTotalBytes: 1,
      }),
    ).toThrow("total-byte limit");

    const assetDir = tempDirs.make("openclaw-plugin-npm-security-asset-bounds-");
    writeFileSync(join(assetDir, "asset.bin"), Buffer.alloc(11));
    expect(() =>
      stageScannerRelevantPackedFiles(assetDir, ["asset.bin"], {
        maxPackedFileBytes: 20,
        maxPackedFiles: 10,
        maxPackedTotalBytes: 10,
        maxFileBytes: 10,
        maxFiles: 10,
        maxTotalBytes: 10,
      }),
    ).toThrow("Packed input exceeds the total-byte limit");
  });

  it("normalizes only exact bundler hash filenames", () => {
    expect(normalizePackedFindingPath("dist/service-BaCqPs_5.js")).toBe("dist/service-<hash>.js");
    expect(normalizePackedFindingPath("dist/service-malware.js")).toBe("dist/service-malware.js");
  });

  it("retains expected SHAs and redacts candidate paths in failure reports", () => {
    const root = tempDirs.make("openclaw-plugin-npm-security-failure-");
    const candidateRoot = join(root, "missing-candidate");
    const reportPath = join(root, "report.json");
    const candidateSha = "1".repeat(40);
    const toolingSha = "2".repeat(40);
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/plugin-npm-security-scan.mts",
        "--candidate-root",
        candidateRoot,
        "--candidate-sha",
        candidateSha,
        "--tooling-sha",
        toolingSha,
        "--report",
        reportPath,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      candidateSha: string;
      toolingSha: string;
    };

    expect(result.status).toBe(1);
    expect(report.candidateSha).toBe(candidateSha);
    expect(report.toolingSha).toBe(toolingSha);
    expect(JSON.stringify(report)).not.toContain(candidateRoot);
    expect(result.stderr).not.toContain(candidateRoot);
  });

  it("finds malicious packed code and retains it when another package fails", async () => {
    const maliciousDir = tempDirs.make("openclaw-plugin-npm-security-malicious-");
    writeFileSync(
      join(maliciousDir, "package.json"),
      `${JSON.stringify({
        files: ["index.js"],
        name: "@openclaw/test-malicious",
        version: "1.0.0",
      })}\n`,
      "utf8",
    );
    writeFileSync(
      join(maliciousDir, "index.js"),
      `const { execSync } = require("node:child_process");\nexecSync("id");\n`,
      "utf8",
    );

    const oversizedDir = tempDirs.make("openclaw-plugin-npm-security-failing-");
    writeFileSync(
      join(oversizedDir, "package.json"),
      `${JSON.stringify({
        files: ["oversized.js"],
        name: "@openclaw/test-oversized",
        version: "1.0.0",
      })}\n`,
      "utf8",
    );
    writeFileSync(join(oversizedDir, "oversized.js"), Buffer.alloc(1024 * 1024 + 1));

    const { packageResults, scanErrors } = await scanPublishablePluginPackages([
      { packageDir: oversizedDir, packageName: "@openclaw/test-oversized" },
      { packageDir: maliciousDir, packageName: "@openclaw/test-malicious" },
    ]);

    expect(packageResults).toHaveLength(1);
    expect(packageResults[0]?.unexpectedCriticalFindings).toEqual([
      {
        line: 2,
        path: "index.js",
        ruleId: "dangerous-exec",
      },
    ]);
    expect(scanErrors).toHaveLength(1);
    expect(scanErrors[0]).toContain("@openclaw/test-oversized");
    expect(scanErrors[0]).not.toContain(oversizedDir);

    const report = buildPluginNpmSecurityScanReport({
      candidateSha: "1".repeat(40),
      packageResults,
      scanErrors,
      toolingSha: "2".repeat(40),
    });
    expect(report.status).toBe("fail");
    expect(report.errors).toContainEqual(expect.stringContaining("unexpected critical findings"));
    expect(report.errors).toContainEqual(expect.stringContaining("package scan failed"));
    expect(JSON.stringify(report)).not.toContain("execSync");
    expect(JSON.stringify(report)).toBe(
      JSON.stringify(
        buildPluginNpmSecurityScanReport({
          candidateSha: report.candidateSha,
          packageResults: structuredClone(packageResults).reverse(),
          scanErrors: structuredClone(scanErrors).reverse(),
          toolingSha: report.toolingSha,
        }),
      ),
    );
  });

  it("scans the complete current-root publishable plugin inventory", async () => {
    const report = await runPluginNpmSecurityScan({
      candidateDir: process.cwd(),
      toolingDir: process.cwd(),
    });

    expect(report).toMatchObject({
      layout: "current",
      status: "pass",
      summary: {
        unexpectedCriticalFindingCount: 0,
      },
    });
    expect(report.summary.packageCount).toBe(report.packages.length);
    expect(report.summary.packageCount).toBeGreaterThan(0);
    expect(
      report.packages
        .find((entry) => entry.packageName === "@openclaw/acpx")
        ?.reviewedCriticalFindings.some((finding) => finding.endsWith(".test.ts")),
    ).toBe(true);
  }, 120_000);
});
