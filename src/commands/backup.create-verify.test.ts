// Backup create/verify tests cover archive creation, runtime output, and verification failure handling.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { backupCreateCommand } from "./backup.js";

const createBackupArchiveMock = vi.hoisted(() => vi.fn());
const backupVerifyCommandMock = vi.hoisted(() => vi.fn());
const writeRuntimeJsonMock = vi.hoisted(() => vi.fn());
const formatBackupCreateSummaryMock = vi.hoisted(() => vi.fn(() => ["backup ok"]));
const recordBackupRunOutcomeMock = vi.hoisted(() => vi.fn());
const withDoctorSqliteMaintenanceLockMock = vi.hoisted(() =>
  vi.fn(async (params: { run: () => Promise<unknown> }) => await params.run()),
);

vi.mock("../infra/backup-create.js", () => ({
  createBackupArchive: createBackupArchiveMock,
  formatBackupCreateSummary: formatBackupCreateSummaryMock,
}));

vi.mock("./backup-verify.js", () => ({
  backupVerifyCommand: backupVerifyCommandMock,
}));

vi.mock("../runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime.js")>("../runtime.js");
  return {
    ...actual,
    writeRuntimeJson: writeRuntimeJsonMock,
  };
});

vi.mock("../state/backup-run-records.js", () => ({
  recordBackupRunOutcome: recordBackupRunOutcomeMock,
}));

vi.mock("./doctor-sqlite-maintenance-lock.js", () => ({
  withDoctorSqliteMaintenanceLock: withDoctorSqliteMaintenanceLockMock,
}));

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  } satisfies RuntimeEnv;
}

function requireBackupVerifyCall(): [RuntimeEnv, Record<string, unknown>] {
  const call = backupVerifyCommandMock.mock.calls[0];
  if (!call) {
    throw new Error("expected backup verify command call");
  }
  return call as [RuntimeEnv, Record<string, unknown>];
}

describe("backupCreateCommand verify wrapper", () => {
  beforeEach(() => {
    createBackupArchiveMock.mockReset();
    backupVerifyCommandMock.mockReset();
    writeRuntimeJsonMock.mockReset();
    formatBackupCreateSummaryMock.mockReset();
    formatBackupCreateSummaryMock.mockReturnValue(["backup ok"]);
    recordBackupRunOutcomeMock.mockReset();
    withDoctorSqliteMaintenanceLockMock.mockReset();
    withDoctorSqliteMaintenanceLockMock.mockImplementation(
      async (params: { run: () => Promise<unknown> }) => await params.run(),
    );
  });

  it("optionally verifies the archive after writing it", async () => {
    createBackupArchiveMock.mockResolvedValue({
      archivePath: "/tmp/openclaw-backup.tar.gz",
      archiveRoot: "openclaw-backup",
      createdAt: "2026-04-07T00:00:00.000Z",
      runtimeVersion: "test",
      assetCount: 1,
      entryCount: 2,
      assets: [],
      verified: false,
      dryRun: false,
      includeWorkspace: false,
      onlyConfig: false,
    });
    backupVerifyCommandMock.mockResolvedValue({
      ok: true,
      archivePath: "/tmp/openclaw-backup.tar.gz",
    });

    const runtime = createRuntime();
    const result = await backupCreateCommand(runtime, { verify: true });

    expect(result.verified).toBe(true);
    expect(backupVerifyCommandMock).toHaveBeenCalledOnce();
    const [verifyRuntime, verifyOptions] = requireBackupVerifyCall();
    expect(verifyOptions).toStrictEqual({
      archive: "/tmp/openclaw-backup.tar.gz",
      json: false,
    });
    const verifyLog = verifyRuntime?.log;
    expect(verifyRuntime).toStrictEqual({
      log: verifyLog,
      error: runtime.error,
      exit: runtime.exit,
    });
    expect(verifyLog).not.toBe(runtime.log);
    expect(typeof verifyLog).toBe("function");
    expect(withDoctorSqliteMaintenanceLockMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "backup archive creation",
        protectedPaths: [expect.any(String)],
        run: expect.any(Function),
      }),
    );
  });

  it("does not take offline state ownership for dry runs or config-only archives", async () => {
    createBackupArchiveMock.mockResolvedValue({
      archivePath: "/tmp/openclaw-backup.tar.gz",
      archiveRoot: "openclaw-backup",
      createdAt: "2026-04-07T00:00:00.000Z",
      assets: [],
      verified: false,
      dryRun: true,
      includeWorkspace: false,
      onlyConfig: false,
    });

    await backupCreateCommand(createRuntime(), { dryRun: true });
    await backupCreateCommand(createRuntime(), { onlyConfig: true });

    expect(withDoctorSqliteMaintenanceLockMock).not.toHaveBeenCalled();
  });

  it("does not claim completion when both backup and outcome recording fail", async () => {
    const backupError = new Error("snapshot failed");
    createBackupArchiveMock.mockRejectedValue(backupError);
    recordBackupRunOutcomeMock.mockImplementation(() => {
      throw new Error("record failed");
    });
    const runtime = createRuntime();

    await expect(backupCreateCommand(runtime)).rejects.toBe(backupError);

    expect(runtime.error).toHaveBeenCalledWith(
      "Warning: the backup outcome could not be recorded: record failed",
    );
  });
});
