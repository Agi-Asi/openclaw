import { existsSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertCompleteScannerSummary,
  collectNpmPackedFiles,
  resolveReviewedSourceLayout,
  runPluginNpmSecurityScan,
  stageScannerRelevantPackedFiles,
} from "../../scripts/lib/plugin-npm-security-scan.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("scripts/lib/plugin-npm-security-scan.mts", () => {
  it("accepts only the complete current and beta3 source layouts", () => {
    const current = [
      "@openclaw/codex:dangerous-exec:src/app-server/sandbox-exec-server/sandbox-child.ts",
      "@openclaw/codex:dangerous-exec:src/app-server/transport-process-containment.ts",
    ];
    const beta3 = [
      "@openclaw/codex:dangerous-exec:src/app-server/sandbox-exec-server/http.ts",
      "@openclaw/codex:dangerous-exec:src/app-server/sandbox-exec-server/processes.ts",
      "@openclaw/codex:dangerous-exec:src/node-cli-sessions.ts",
      "@openclaw/opencode-provider:dangerous-exec:session-catalog.ts",
    ];

    expect(resolveReviewedSourceLayout(current)?.id).toBe("current");
    expect(resolveReviewedSourceLayout(beta3)?.id).toBe("beta3");
    expect(resolveReviewedSourceLayout(beta3.slice(0, -1))).toBeUndefined();
    expect(resolveReviewedSourceLayout([...current, beta3[0]!])).toBeUndefined();
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
  }, 120_000);
});
