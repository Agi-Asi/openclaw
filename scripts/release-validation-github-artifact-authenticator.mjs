import {
  downloadActionsArtifactArchive,
  inspectActionsArtifactZipWithPolicy,
  sha256Digest,
} from "./lib/actions-artifact-archive.mjs";
import { isRecord } from "./lib/record-shared.mjs";
import {
  RELEASE_VALIDATION_RECEIPT_MAX_BYTES,
  verifyReleaseValidationArtifactEvidence,
} from "./release-validation-receipt-contract.mjs";

const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const REPOSITORY = "openclaw/openclaw";
const WORKFLOW_PATH = ".github/workflows/full-release-validation.yml";
const SHA_PATTERN = /^[a-f0-9]{40}$/u;

function fail(message) {
  throw new Error(message);
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(`${label} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function string(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function repositoryName(value, label) {
  if (!isRecord(value) || typeof value.full_name !== "string") {
    fail(`${label} must include full_name`);
  }
  return value.full_name;
}

function timestampMs(value, label) {
  const text = string(value, label);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) {
    fail(`${label} must be a valid timestamp`);
  }
  return milliseconds;
}

export function authenticateGitHubReleaseValidationArtifact(params) {
  if (!isRecord(params)) {
    fail("GitHub release validation artifact authentication parameters are required");
  }
  const evidence = params.evidence;
  const expected = params.expected;
  const artifact = params.artifactMetadata;
  const run = params.workflowRun;
  if (!isRecord(evidence) || !isRecord(expected) || !isRecord(artifact) || !isRecord(run)) {
    fail("GitHub release validation artifact metadata is incomplete");
  }
  if (!(params.archiveBytes instanceof Uint8Array)) {
    fail("GitHub release validation artifact archiveBytes must be a Uint8Array");
  }
  const archiveBytes = Buffer.from(
    params.archiveBytes.buffer,
    params.archiveBytes.byteOffset,
    params.archiveBytes.byteLength,
  );
  const nowMs = nonNegativeInteger(params.nowMs, "GitHub artifact authentication nowMs");
  const repository = string(expected.repository, "GitHub artifact expected repository");
  const workflowPath = string(expected.workflowPath, "GitHub artifact expected workflow path");
  const workflowSha = string(expected.workflowSha, "GitHub artifact expected workflow SHA");
  if (
    repository !== REPOSITORY ||
    workflowPath !== WORKFLOW_PATH ||
    !SHA_PATTERN.test(workflowSha)
  ) {
    fail("GitHub artifact expected repository or workflow authority is unsupported");
  }
  const artifactId = positiveInteger(
    Number(evidence.artifact_id),
    "GitHub artifact evidence artifact_id",
  );
  const runId = positiveInteger(Number(evidence.run_id), "GitHub artifact evidence run_id");
  const runAttempt = positiveInteger(evidence.run_attempt, "GitHub artifact evidence run_attempt");
  const createdAtMs = timestampMs(evidence.created_at, "GitHub artifact evidence created_at");
  const expiresAtMs = timestampMs(evidence.expires_at, "GitHub artifact evidence expires_at");
  if (
    artifact.id !== artifactId ||
    artifact.name !== evidence.artifact_name ||
    artifact.digest !== evidence.archive_digest ||
    artifact.created_at !== evidence.created_at ||
    artifact.expires_at !== evidence.expires_at ||
    artifact.expired !== false ||
    artifact.size_in_bytes !== archiveBytes.byteLength ||
    !isRecord(artifact.workflow_run) ||
    artifact.workflow_run.id !== runId ||
    artifact.workflow_run.head_sha !== workflowSha
  ) {
    fail("GitHub artifact metadata differs from the authenticated evidence tuple");
  }
  if (
    run.id !== runId ||
    run.run_attempt !== runAttempt ||
    run.path !== workflowPath ||
    run.head_sha !== workflowSha ||
    repositoryName(run.repository, "GitHub workflow repository") !== repository ||
    repositoryName(run.head_repository, "GitHub workflow head repository") !== repository
  ) {
    fail("GitHub workflow metadata differs from the authenticated evidence tuple");
  }
  if (createdAtMs > nowMs || createdAtMs >= expiresAtMs || expiresAtMs <= nowMs) {
    fail("GitHub artifact is expired or has invalid creation/expiry timestamps");
  }
  if (sha256Digest(archiveBytes) !== evidence.archive_digest) {
    fail("downloaded GitHub artifact archive digest differs from metadata");
  }
  const files = inspectActionsArtifactZipWithPolicy(archiveBytes, {
    expectedEntries: [evidence.entry_name],
    maxArchiveBytes: MAX_ARCHIVE_BYTES,
    maxExpandedBytes: RELEASE_VALIDATION_RECEIPT_MAX_BYTES,
    maxEntryBytes: () => RELEASE_VALIDATION_RECEIPT_MAX_BYTES,
  });
  const entryBytes = files.get(evidence.entry_name);
  if (
    !entryBytes ||
    typeof evidence.entry_bytes !== "string" ||
    !entryBytes.equals(Buffer.from(evidence.entry_bytes, "ascii"))
  ) {
    fail("GitHub artifact entry bytes differ from the authenticated evidence");
  }
  return verifyReleaseValidationArtifactEvidence(evidence, () => true);
}

export async function downloadAndAuthenticateGitHubReleaseValidationArtifact(params) {
  if (!isRecord(params) || !isRecord(params.evidence) || !isRecord(params.expected)) {
    fail("GitHub release validation artifact download parameters are required");
  }
  const evidence = params.evidence;
  const expected = params.expected;
  const downloaded = await downloadActionsArtifactArchive({
    expected: {
      artifactDigest: evidence.archive_digest,
      artifactId: Number(evidence.artifact_id),
      artifactName: evidence.artifact_name,
      artifactSizeBytes: expected.artifactSizeBytes,
      repository: expected.repository,
      runStatePolicy: expected.runStatePolicy,
      runAttempt: evidence.run_attempt,
      runId: Number(evidence.run_id),
      workflowEvent: expected.workflowEvent,
      workflowHeadBranch: expected.workflowHeadBranch,
      workflowPath: expected.workflowPath,
      workflowSha: expected.workflowSha,
      ...(expected.consumerRunAttempt === undefined
        ? {}
        : { consumerRunAttempt: expected.consumerRunAttempt }),
      ...(expected.producerJobName === undefined
        ? {}
        : { producerJobName: expected.producerJobName }),
    },
    token: params.token,
    ...(params.fetchImpl === undefined ? {} : { fetchImpl: params.fetchImpl }),
    ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
    ...(params.retryAttempts === undefined ? {} : { retryAttempts: params.retryAttempts }),
    ...(params.retryDelayMs === undefined ? {} : { retryDelayMs: params.retryDelayMs }),
    maxArchiveBytes: MAX_ARCHIVE_BYTES,
  });
  return authenticateGitHubReleaseValidationArtifact({
    evidence,
    expected,
    artifactMetadata: downloaded.artifactMetadata,
    workflowRun: downloaded.workflowRun,
    archiveBytes: downloaded.archiveBytes,
    nowMs: params.nowMs,
  });
}
