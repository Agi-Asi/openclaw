type CheckpointKind = "plan" | "decision" | "drain";
type JsonRecord = Record<string, unknown>;

export function encodeFullReleaseValidationLogCheckpoint(params: {
  kind: CheckpointKind;
  payload: unknown;
  provenance: JsonRecord;
}): string[];
export function parseFullReleaseValidationLogCheckpoint(
  log: string,
  expected: JsonRecord,
): { envelope: JsonRecord; payload: unknown } | undefined;
export function readFullReleaseValidationLogCheckpointFromGitHub(params: {
  getJobLog: (jobId: unknown) => string;
  getJobs: () => JsonRecord[];
  getRun: () => JsonRecord;
  kind: CheckpointKind;
  runAttempt: number;
  runId: string;
  targetSha: string;
  workflowSha: string;
}): JsonRecord | undefined;
export function recoverFullReleaseValidationLogCheckpoint(params: {
  currentAttempt: number;
  expected: JsonRecord;
  kind: CheckpointKind;
  listJobsForAttempt: (attempt: number) => Promise<JsonRecord[]>;
  readJobLog: (jobId: unknown) => Promise<string>;
}): Promise<JsonRecord>;
