// CLI command wrapper for backup archive creation and optional verification.
import {
  createBackupArchive,
  formatBackupCreateSummary,
  type BackupCreateOptions,
  type BackupCreateResult,
} from "../infra/backup-create.js";
import { resolveStateDir } from "../config/paths.js";
import { formatErrorMessage } from "../infra/errors.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { recordBackupRunOutcome } from "../state/backup-run-records.js";
import { withDoctorSqliteMaintenanceLock } from "./doctor-sqlite-maintenance-lock.js";

type BackupVerifyRuntime = typeof import("./backup-verify.js");

const backupVerifyRuntimeLoader = createLazyImportLoader<BackupVerifyRuntime>(
  () => import("./backup-verify.js"),
);

function loadBackupVerifyRuntime(): Promise<BackupVerifyRuntime> {
  return backupVerifyRuntimeLoader.load();
}

/** Create a backup archive, optionally verify it, and emit text or JSON output. */
export async function backupCreateCommand(
  runtime: RuntimeEnv,
  opts: BackupCreateOptions = {},
): Promise<BackupCreateResult> {
  let archivePath = opts.output ?? process.cwd();
  try {
    const createArchive = async () =>
      await createBackupArchive({
        ...opts,
        log: opts.log ?? (opts.json ? undefined : (message: string) => runtime.log(message)),
      });
    // Archive creation captures the selected memory state and its SQLite snapshots. A CLI cannot
    // quiesce a live Gateway-owned broker, so require offline state ownership instead of taking a
    // potentially inconsistent archive while the broker can still activate artifacts.
    const result =
      opts.dryRun || opts.onlyConfig
        ? await createArchive()
        : await withDoctorSqliteMaintenanceLock({
            operation: "backup archive creation",
            protectedPaths: [resolveStateDir(process.env)],
            run: createArchive,
          });
    archivePath = result.archivePath;
    if (opts.verify && !opts.dryRun) {
      const { backupVerifyCommand } = await loadBackupVerifyRuntime();
      await backupVerifyCommand(
        {
          ...runtime,
          log: () => {},
        },
        { archive: result.archivePath, json: false },
      );
      result.verified = true;
    }
    if (!opts.dryRun) {
      recordBackupOutcomeBestEffort(runtime, {
        archivePath,
        status: "ok",
      });
    }
    if (opts.json) {
      writeRuntimeJson(runtime, result);
    } else {
      runtime.log(formatBackupCreateSummary(result).join("\n"));
    }
    return result;
  } catch (error) {
    if (!opts.dryRun) {
      recordBackupOutcomeBestEffort(runtime, {
        archivePath,
        status: "failed",
        error: formatErrorMessage(error),
      });
    }
    throw error;
  }
}

function recordBackupOutcomeBestEffort(
  runtime: RuntimeEnv,
  params: { archivePath: string; status: "ok" | "failed"; error?: string },
): void {
  try {
    recordBackupRunOutcome({ kind: "archive", ...params });
  } catch (error) {
    runtime.error(
      `Warning: the backup outcome could not be recorded: ${formatErrorMessage(error)}`,
    );
  }
}
