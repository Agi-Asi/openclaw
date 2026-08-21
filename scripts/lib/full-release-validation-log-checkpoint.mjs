import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";

const FULL_RELEASE_CHECKPOINT_MAX_BYTES = 128 * 1024;
const FULL_RELEASE_CHECKPOINT_MAX_CHUNKS = 16;
const FULL_RELEASE_CHECKPOINT_CHUNK_BYTES = 8 * 1024;

const CHECKPOINT_VERSION = 1;
const MARKER = "[openclaw-frv-checkpoint]";
const WORKFLOW_NAME = "Full Release Validation";
const WORKFLOW_PATH = ".github/workflows/full-release-validation.yml";
const TIMESTAMP_PREFIX_PATTERN = /^\s*(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+)?/u;
const CHECKPOINT_KINDS = new Set(["plan", "decision", "drain"]);

const FULL_RELEASE_CHECKPOINT_PRODUCERS = Object.freeze({
  decision: { jobKey: "release_decision", jobName: "Release Decision" },
  drain: { jobKey: "diagnostic_drain", jobName: "Diagnostic Drain" },
  plan: {
    jobKey: "release_execution_plan",
    jobName: "Seal release execution plan",
  },
});

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function positiveInteger(value, label) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return normalized;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function encodeBase64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function decodeBase64url(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value))
    throw new Error(`${label} is not canonical base64url`);
  const decoded = Buffer.from(value, "base64url");
  if (encodeBase64url(decoded) !== value) throw new Error(`${label} is not canonical base64url`);
  return decoded;
}

function normalizeKind(value) {
  const kind = requiredString(value, "checkpoint kind");
  if (!CHECKPOINT_KINDS.has(kind)) throw new Error(`checkpoint kind is invalid: ${kind}`);
  return kind;
}

function normalizeProvenance(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("checkpoint provenance must be an object");
  }
  return {
    runAttempt: positiveInteger(value.runAttempt, "checkpoint run attempt"),
    runId: requiredString(String(value.runId ?? ""), "checkpoint run ID"),
    targetSha: requiredString(value.targetSha, "checkpoint target SHA"),
    workflowId: positiveInteger(value.workflowId, "checkpoint workflow ID"),
    workflowPath: requiredString(value.workflowPath, "checkpoint workflow path"),
    workflowSha: requiredString(value.workflowSha, "checkpoint workflow SHA"),
  };
}

function normalizeEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("checkpoint header must be an object");
  }
  const kind = normalizeKind(value.kind);
  const producer = FULL_RELEASE_CHECKPOINT_PRODUCERS[kind];
  const envelope = {
    byteLength: positiveInteger(value.byteLength, "checkpoint byte length"),
    chunkCount: positiveInteger(value.chunkCount, "checkpoint chunk count"),
    kind,
    payloadSha256: requiredString(value.payloadSha256, "checkpoint payload digest"),
    producerJobKey: requiredString(value.producerJobKey, "checkpoint producer job key"),
    runAttempt: positiveInteger(value.runAttempt, "checkpoint run attempt"),
    runId: requiredString(String(value.runId ?? ""), "checkpoint run ID"),
    targetSha: requiredString(value.targetSha, "checkpoint target SHA"),
    version: positiveInteger(value.version, "checkpoint version"),
    workflowId: positiveInteger(value.workflowId, "checkpoint workflow ID"),
    workflowPath: requiredString(value.workflowPath, "checkpoint workflow path"),
    workflowSha: requiredString(value.workflowSha, "checkpoint workflow SHA"),
  };
  if (
    envelope.version !== CHECKPOINT_VERSION ||
    envelope.chunkCount > FULL_RELEASE_CHECKPOINT_MAX_CHUNKS ||
    envelope.byteLength > FULL_RELEASE_CHECKPOINT_MAX_BYTES ||
    !/^[a-f0-9]{64}$/u.test(envelope.payloadSha256) ||
    envelope.producerJobKey !== producer.jobKey
  ) {
    throw new Error("checkpoint header is invalid");
  }
  return envelope;
}

function assertExpected(envelope, expected) {
  const normalized = {
    ...normalizeProvenance(expected),
    kind: normalizeKind(expected.kind),
    producerJobKey: requiredString(expected.producerJobKey, "expected producer job key"),
  };
  for (const key of [
    "kind",
    "producerJobKey",
    "runAttempt",
    "runId",
    "targetSha",
    "workflowId",
    "workflowPath",
    "workflowSha",
  ]) {
    if (String(envelope[key]) !== String(normalized[key])) {
      throw new Error(`checkpoint provenance mismatch: ${key}`);
    }
  }
}

function markerLines(log) {
  return stripVTControlCharacters(String(log))
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.replace(TIMESTAMP_PREFIX_PATTERN, ""))
    .filter((line) => line.startsWith(`${MARKER} `));
}

function jobLogArgs(repository, jobId, allowEscapeSequences = true) {
  return [
    "api",
    `repos/${repository}/actions/jobs/${jobId}/logs`,
    ...(allowEscapeSequences ? ["--allow-escape-sequences"] : []),
  ];
}

function isUnknownAllowEscapeSequencesFlag(value) {
  const stderr = typeof value === "string" ? value : (value?.stderr ?? value?.message);
  return (
    typeof stderr === "string" &&
    stderr.replace(/\r\n?/gu, "\n").split("\n").includes("unknown flag: --allow-escape-sequences")
  );
}

export function readFullReleaseValidationJobLog(read, repository, jobId) {
  const retryWithoutFlag = (error) => {
    if (!isUnknownAllowEscapeSequencesFlag(error)) {
      throw error;
    }
    return read(jobLogArgs(repository, jobId, false));
  };
  try {
    const result = read(jobLogArgs(repository, jobId));
    return typeof result?.catch === "function" ? result.catch(retryWithoutFlag) : result;
  } catch (error) {
    return retryWithoutFlag(error);
  }
}

function exactProducerJob(jobs, producer, expected, runAttempt) {
  const matches = (Array.isArray(jobs) ? jobs : []).filter(
    (job) => job?.name === producer.jobName && Number(job?.run_attempt) === Number(runAttempt),
  );
  if (matches.length !== 1) {
    throw new Error(
      `checkpoint producer job is not unique for ${producer.jobName} attempt ${runAttempt}`,
    );
  }
  const job = matches[0];
  if (
    !Number.isSafeInteger(Number(job.id)) ||
    String(job.run_id) !== String(expected.runId) ||
    job.head_sha !== expected.workflowSha ||
    job.workflow_name !== WORKFLOW_NAME
  ) {
    throw new Error(`checkpoint producer job binding is invalid at attempt ${runAttempt}`);
  }
  return job;
}

export function encodeFullReleaseValidationLogCheckpoint({ kind, payload, provenance }) {
  const normalizedKind = normalizeKind(kind);
  const normalizedProvenance = normalizeProvenance(provenance);
  const producer = FULL_RELEASE_CHECKPOINT_PRODUCERS[normalizedKind];
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  if (bytes.length === 0 || bytes.length > FULL_RELEASE_CHECKPOINT_MAX_BYTES) {
    throw new Error("checkpoint payload exceeds the size limit");
  }
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += FULL_RELEASE_CHECKPOINT_CHUNK_BYTES) {
    chunks.push(bytes.subarray(offset, offset + FULL_RELEASE_CHECKPOINT_CHUNK_BYTES));
  }
  if (chunks.length > FULL_RELEASE_CHECKPOINT_MAX_CHUNKS) {
    throw new Error("checkpoint payload exceeds the chunk limit");
  }
  const payloadSha256 = sha256(bytes);
  const envelope = {
    byteLength: bytes.length,
    chunkCount: chunks.length,
    kind: normalizedKind,
    payloadSha256,
    producerJobKey: producer.jobKey,
    ...normalizedProvenance,
    version: CHECKPOINT_VERSION,
  };
  return [
    `${MARKER} header ${encodeBase64url(Buffer.from(JSON.stringify(envelope), "utf8"))}`,
    ...chunks.map(
      (chunk, index) =>
        `${MARKER} chunk ${normalizedKind} ${index + 1}/${chunks.length} ${encodeBase64url(chunk)}`,
    ),
    `${MARKER} trailer ${normalizedKind} ${payloadSha256}`,
  ];
}

export function parseFullReleaseValidationLogCheckpoint(log, expected) {
  const lines = markerLines(log);
  if (lines.length === 0) {
    return undefined;
  }
  const headerMatch = /^\[openclaw-frv-checkpoint\] header ([A-Za-z0-9_-]+)$/u.exec(lines[0]);
  if (!headerMatch) {
    throw new Error("checkpoint header is missing or reordered");
  }
  let header;
  try {
    const headerBytes = decodeBase64url(headerMatch[1], "checkpoint header");
    header = normalizeEnvelope(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(headerBytes)),
    );
  } catch (error) {
    throw new Error(
      `checkpoint header is malformed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  assertExpected(header, expected);
  if (lines.length !== header.chunkCount + 2) {
    throw new Error("checkpoint line count is invalid");
  }
  const chunks = [];
  for (let index = 0; index < header.chunkCount; index += 1) {
    const match =
      /^\[openclaw-frv-checkpoint\] chunk ([a-z]+) ([1-9][0-9]*)\/([1-9][0-9]*) ([A-Za-z0-9_-]+)$/u.exec(
        lines[index + 1],
      );
    if (
      !match ||
      match[1] !== header.kind ||
      Number(match[2]) !== index + 1 ||
      Number(match[3]) !== header.chunkCount
    ) {
      throw new Error("checkpoint chunks are missing, duplicated, conflicting, or reordered");
    }
    chunks.push(decodeBase64url(match[4], `checkpoint chunk ${index + 1}`));
  }
  const trailerMatch = /^\[openclaw-frv-checkpoint\] trailer ([a-z]+) ([a-f0-9]{64})$/u.exec(
    lines.at(-1),
  );
  if (
    !trailerMatch ||
    trailerMatch[1] !== header.kind ||
    trailerMatch[2] !== header.payloadSha256
  ) {
    throw new Error("checkpoint trailer is missing or conflicting");
  }
  const bytes = Buffer.concat(chunks);
  if (
    bytes.length !== header.byteLength ||
    bytes.length > FULL_RELEASE_CHECKPOINT_MAX_BYTES ||
    sha256(bytes) !== header.payloadSha256
  ) {
    throw new Error("checkpoint payload length or digest is invalid");
  }
  try {
    return {
      envelope: header,
      payload: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    };
  } catch (error) {
    throw new Error(
      `checkpoint payload is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function readFullReleaseValidationLogCheckpointAttempt({
  expected,
  jobs,
  kind,
  readJobLog,
  runAttempt,
}) {
  const producer = FULL_RELEASE_CHECKPOINT_PRODUCERS[normalizeKind(kind)];
  const candidates = (Array.isArray(jobs) ? jobs : []).filter(
    (job) => job?.name === producer.jobName,
  );
  if (candidates.length === 0) {
    return undefined;
  }
  const job = exactProducerJob(candidates, producer, expected, runAttempt);
  if (job.status !== "completed") {
    return undefined;
  }
  const checkpoint = parseFullReleaseValidationLogCheckpoint(readJobLog(job.id), {
    ...expected,
    kind,
    producerJobKey: producer.jobKey,
    runAttempt,
  });
  if (checkpoint) {
    return { ...checkpoint, job, sourceAttempt: Number(runAttempt) };
  }
  if (job.conclusion === "success") {
    throw new Error(
      `completed checkpoint producer omitted its checkpoint at attempt ${runAttempt}`,
    );
  }
  return undefined;
}

export function readFullReleaseValidationLogCheckpointFromGitHub({
  getJobLog,
  getJobs,
  getRun,
  kind,
  runAttempt,
  runId,
  targetSha,
  workflowSha,
}) {
  const run = getRun();
  const workflowPath = String(run?.path ?? "").split("@", 1)[0];
  if (
    String(run?.id) !== String(runId) ||
    Number(run?.run_attempt) !== Number(runAttempt) ||
    run?.event !== "workflow_dispatch" ||
    run?.head_sha !== workflowSha ||
    workflowPath !== WORKFLOW_PATH
  ) {
    throw new Error(`checkpoint parent run binding mismatch: ${runId}`);
  }
  return readFullReleaseValidationLogCheckpointAttempt({
    expected: {
      runAttempt,
      runId: String(runId),
      targetSha,
      workflowId: run.workflow_id,
      workflowPath,
      workflowSha,
    },
    jobs: getJobs(),
    kind,
    readJobLog: getJobLog,
    runAttempt,
  });
}

export async function recoverFullReleaseValidationLogCheckpoint({
  currentAttempt,
  expected,
  kind,
  listJobsForAttempt,
  readJobLog,
}) {
  const normalizedCurrentAttempt = positiveInteger(currentAttempt, "current run attempt");
  for (let attempt = normalizedCurrentAttempt - 1; attempt >= 1; attempt -= 1) {
    const jobs = await listJobsForAttempt(attempt);
    const producer = FULL_RELEASE_CHECKPOINT_PRODUCERS[kind];
    const job = exactProducerJob(jobs, producer, expected, attempt);
    if (job.status !== "completed") {
      throw new Error(`checkpoint producer job is incomplete at attempt ${attempt}`);
    }
    const log = await readJobLog(job.id);
    const checkpoint = readFullReleaseValidationLogCheckpointAttempt({
      expected,
      jobs,
      kind,
      readJobLog: () => log,
      runAttempt: attempt,
    });
    if (checkpoint) {
      return checkpoint;
    }
  }
  throw new Error(
    `no recoverable ${kind} checkpoint exists before attempt ${normalizedCurrentAttempt}`,
  );
}
