import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  runPluginNpmSecurityScan,
  type PluginNpmSecurityScanReport,
} from "./lib/plugin-npm-security-scan.mts";

function parseArgs(argv: string[]): {
  candidateRoot: string;
  candidateSha: string;
  outputPath: string;
  toolingSha: string;
} {
  let candidateRoot = "";
  let candidateSha = "";
  let toolingSha = "";
  let outputPath = "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--candidate-root") {
      candidateRoot = argv[index + 1] ?? "";
      index += 1;
    } else if (arg === "--candidate-sha") {
      candidateSha = argv[index + 1] ?? "";
      index += 1;
    } else if (arg === "--tooling-sha") {
      toolingSha = argv[index + 1] ?? "";
      index += 1;
    } else if (arg === "--report") {
      outputPath = argv[index + 1] ?? "";
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!candidateRoot) {
    throw new Error("--candidate-root is required");
  }
  if (!/^[0-9a-f]{40}$/u.test(candidateSha)) {
    throw new Error("--candidate-sha must be a full lowercase commit SHA");
  }
  if (!/^[0-9a-f]{40}$/u.test(toolingSha)) {
    throw new Error("--tooling-sha must be a full lowercase commit SHA");
  }
  if (!outputPath) {
    throw new Error("--report is required");
  }
  return {
    candidateRoot: resolve(candidateRoot),
    candidateSha,
    outputPath: resolve(outputPath),
    toolingSha,
  };
}

async function writeReport(outputPath: string, report: PluginNpmSecurityScanReport): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function main(argv = process.argv.slice(2)): Promise<number> {
  let args: ReturnType<typeof parseArgs> | undefined;
  try {
    args = parseArgs(argv);
    const report = await runPluginNpmSecurityScan({
      candidateDir: args.candidateRoot,
      toolingDir: process.cwd(),
    });
    if (report.candidateSha !== args.candidateSha) {
      report.errors.push(
        `Candidate checkout resolved to ${report.candidateSha}, expected ${args.candidateSha}.`,
      );
      report.status = "fail";
    }
    if (report.toolingSha !== args.toolingSha) {
      report.errors.push(
        `Tooling checkout resolved to ${report.toolingSha}, expected ${args.toolingSha}.`,
      );
      report.status = "fail";
    }
    await writeReport(args.outputPath, report);
    console.log(
      `Plugin npm security scan ${report.status}: ${report.summary.packageCount} packages, layout=${report.layout ?? "unknown"}, candidate=${report.candidateSha}, tooling=${report.toolingSha}`,
    );
    for (const error of report.errors) {
      console.error(`- ${error}`);
    }
    return report.status === "pass" ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Plugin npm security scan failed: ${message}`);
    if (args) {
      await writeReport(args.outputPath, {
        candidateSha: "",
        errors: [message],
        layout: null,
        packages: [],
        schemaVersion: 1,
        status: "fail",
        summary: {
          packageCount: 0,
          reviewedCriticalFindingCount: 0,
          unexpectedCriticalFindingCount: 0,
        },
        toolingSha: "",
      });
    }
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main();
}
