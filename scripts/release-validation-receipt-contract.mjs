import { isRecord } from "./lib/record-shared.mjs";
import {
  canonicalReleaseJson,
  parseCanonicalReleaseJson,
  releaseCanonicalDigest,
  RELEASE_PLAN_CANONICALIZATION,
} from "./release-plan-contract.mjs";
import {
  releaseValidationIntentForPurpose,
  resolveReleaseValidationIntent,
} from "./release-validation-intent.mjs";

export const RELEASE_VALIDATION_RECEIPT_SCHEMA = "openclaw.release-validation-receipt.v1";
export const RELEASE_VALIDATION_RECEIPT_LOCATOR_SCHEMA =
  "openclaw.release-validation-receipt-locator.v1";
export const RELEASE_VALIDATION_POLICY_ID = "openclaw.release-validation-policy.v1";
export const RELEASE_VALIDATION_RECEIPT_MAX_BYTES = 256 * 1024;
export const RELEASE_VALIDATION_RECEIPT_LOCATOR_MAX_BYTES = 16 * 1024;

const REPOSITORY = "openclaw/openclaw";
const WORKFLOW_PATH = ".github/workflows/full-release-validation.yml";
const WORKFLOW_NAME = "Full Release Validation";
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const ASCII_PATTERN = /^[\x20-\x7e]+$/u;
const RUN_ID_PATTERN = /^[1-9][0-9]*$/u;
const REF_PATTERN = /^refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+$/u;
const TIMESTAMP_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/u;
const URL_PATTERN =
  /^https:\/\/github\.com\/openclaw\/openclaw\/actions\/runs\/[1-9][0-9]*(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$/u;
const GROUP_MODES = new Set(["blocking", "diagnostic"]);
const POLICY_OUTCOMES = new Set(["blocked", "orchestration-error", "passed"]);
const RUN_CONCLUSIONS = new Set([
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "skipped",
  "stale",
  "startup_failure",
  "success",
  "timed_out",
]);
const JOB_POLICIES = new Set(["advisory", "blocking"]);
const SOURCE_ARTIFACT_KINDS = new Set([
  "candidate",
  "child-evidence",
  "decision",
  "diagnostic-drain",
  "execution-plan",
  "release-plan-lock",
  "validation-manifest",
]);
const compareAscii = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function fail(message) {
  throw new Error(message);
}

function exactKeys(value, keys, label) {
  const actual = Object.keys(value).toSorted(compareAscii);
  const expected = [...keys].toSorted(compareAscii);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} keys must be exactly: ${expected.join(", ")}`);
  }
}

function object(value, label) {
  if (!isRecord(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function asciiString(value, label) {
  if (typeof value !== "string" || !ASCII_PATTERN.test(value)) {
    fail(`${label} must be a non-empty printable ASCII string`);
  }
  return value;
}

function enumString(value, allowed, label) {
  const result = asciiString(value, label);
  if (!allowed.has(result)) {
    fail(`${label} contains unsupported value: ${result}`);
  }
  return result;
}

function sha(value, label) {
  const result = asciiString(value, label);
  if (!SHA_PATTERN.test(result)) {
    fail(`${label} must be a lowercase 40-character commit SHA`);
  }
  return result;
}

function digest(value, label) {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    fail(`${label} must be sha256:<64 lowercase hex characters>`);
  }
  return value;
}

function runId(value, label) {
  const result = asciiString(value, label);
  if (!RUN_ID_PATTERN.test(result)) {
    fail(`${label} must be a positive integer string`);
  }
  return result;
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

function timestamp(value, label) {
  const result = asciiString(value, label);
  if (!TIMESTAMP_PATTERN.test(result)) {
    fail(`${label} must use canonical UTC seconds`);
  }
  const milliseconds = Date.parse(result);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString().replace(".000Z", "Z") !== result
  ) {
    fail(`${label} must be a valid canonical UTC timestamp`);
  }
  return result;
}

function nullableTimestamp(value, label) {
  return value === null ? null : timestamp(value, label);
}

function actionUrl(value, label) {
  const result = asciiString(value, label);
  if (!URL_PATTERN.test(result)) {
    fail(`${label} must be an OpenClaw GitHub Actions URL`);
  }
  return result;
}

function qualifiedRef(value, label) {
  const result = asciiString(value, label);
  if (!REF_PATTERN.test(result)) {
    fail(`${label} must be a qualified branch or tag ref`);
  }
  return result;
}

function targetRef(value, targetSha, label) {
  const result = asciiString(value, label);
  if (result !== targetSha && !REF_PATTERN.test(result)) {
    fail(`${label} must be the target SHA or a qualified branch or tag ref`);
  }
  return result;
}

function boolean(value, label) {
  if (typeof value !== "boolean") {
    fail(`${label} must be boolean`);
  }
  return value;
}

function nullableDigest(value, label) {
  return value === null ? null : digest(value, label);
}

function validateTarget(value) {
  const target = object(value, "release validation receipt target");
  exactKeys(target, ["repository", "ref", "sha"], "release validation receipt target");
  const targetSha = sha(target.sha, "release validation receipt target SHA");
  const result = {
    repository: asciiString(target.repository, "release validation receipt target repository"),
    ref: targetRef(target.ref, targetSha, "release validation receipt target ref"),
    sha: targetSha,
  };
  if (result.repository !== REPOSITORY) {
    fail(`release validation receipt target repository must be ${REPOSITORY}`);
  }
  return result;
}

function validateTooling(value) {
  const tooling = object(value, "release validation receipt tooling");
  exactKeys(tooling, ["repository", "ref", "sha"], "release validation receipt tooling");
  const result = {
    repository: asciiString(tooling.repository, "release validation receipt tooling repository"),
    ref: qualifiedRef(tooling.ref, "release validation receipt tooling ref"),
    sha: sha(tooling.sha, "release validation receipt tooling SHA"),
  };
  if (result.repository !== REPOSITORY) {
    fail(`release validation receipt tooling repository must be ${REPOSITORY}`);
  }
  return result;
}

function validateAttempt(value, tooling) {
  const attempt = object(value, "release validation receipt attempt");
  exactKeys(
    attempt,
    [
      "workflow_path",
      "workflow_name",
      "workflow_ref",
      "workflow_sha",
      "run_id",
      "run_attempt",
      "url",
    ],
    "release validation receipt attempt",
  );
  const result = {
    workflow_path: asciiString(
      attempt.workflow_path,
      "release validation receipt attempt workflow_path",
    ),
    workflow_name: asciiString(
      attempt.workflow_name,
      "release validation receipt attempt workflow_name",
    ),
    workflow_ref: qualifiedRef(
      attempt.workflow_ref,
      "release validation receipt attempt workflow_ref",
    ),
    workflow_sha: sha(attempt.workflow_sha, "release validation receipt attempt workflow_sha"),
    run_id: runId(attempt.run_id, "release validation receipt attempt run_id"),
    run_attempt: positiveInteger(
      attempt.run_attempt,
      "release validation receipt attempt run_attempt",
    ),
    url: actionUrl(attempt.url, "release validation receipt attempt URL"),
  };
  if (result.workflow_path !== WORKFLOW_PATH || result.workflow_name !== WORKFLOW_NAME) {
    fail("release validation receipt attempt must identify Full Release Validation");
  }
  if (!result.url.includes(`/actions/runs/${result.run_id}`)) {
    fail("release validation receipt attempt URL must bind its run_id");
  }
  if (result.workflow_ref !== tooling.ref || result.workflow_sha !== tooling.sha) {
    fail("release validation receipt attempt workflow identity differs from tooling");
  }
  return result;
}

function validateReleasePlanBinding(value) {
  const releasePlan = object(value, "release validation receipt release_plan");
  exactKeys(
    releasePlan,
    ["schema", "purpose", "plan_digest", "lock_digest"],
    "release validation receipt release_plan",
  );
  if (releasePlan.schema !== "openclaw.release-plan.v1") {
    fail("release validation receipt release_plan schema is unsupported");
  }
  return {
    schema: "openclaw.release-plan.v1",
    purpose: asciiString(releasePlan.purpose, "release validation receipt release_plan purpose"),
    plan_digest: digest(
      releasePlan.plan_digest,
      "release validation receipt release_plan plan_digest",
    ),
    lock_digest: digest(
      releasePlan.lock_digest,
      "release validation receipt release_plan lock_digest",
    ),
  };
}

function validateValidation(value, purpose) {
  const validation = object(value, "release validation receipt validation");
  exactKeys(
    validation,
    ["intent", "profile", "soak", "policy"],
    "release validation receipt validation",
  );
  const policy = object(validation.policy, "release validation receipt validation policy");
  exactKeys(policy, ["id", "fail_fast", "outcome"], "release validation receipt validation policy");
  const intent = asciiString(validation.intent, "release validation receipt validation intent");
  releaseValidationIntentForPurpose(purpose, intent);
  const resolved = resolveReleaseValidationIntent(intent, {
    profile: asciiString(validation.profile, "release validation receipt validation profile"),
    soak: boolean(validation.soak, "release validation receipt validation soak"),
  });
  const policyId = asciiString(policy.id, "release validation receipt validation policy id");
  if (policyId !== RELEASE_VALIDATION_POLICY_ID) {
    fail(`release validation receipt validation policy id must be ${RELEASE_VALIDATION_POLICY_ID}`);
  }
  return {
    intent: resolved.intent,
    profile: resolved.profile,
    soak: resolved.soak,
    policy: {
      id: policyId,
      fail_fast: boolean(
        policy.fail_fast,
        "release validation receipt validation policy fail_fast",
      ),
      outcome: enumString(
        policy.outcome,
        POLICY_OUTCOMES,
        "release validation receipt validation policy outcome",
      ),
    },
  };
}

function validateSourceAttempt(value, label, withSourceAttempt) {
  const source = object(value, label);
  exactKeys(
    source,
    withSourceAttempt
      ? ["schema", "digest", "parent_run_attempt", "source_parent_run_attempt"]
      : ["schema", "digest", "parent_run_attempt"],
    label,
  );
  return {
    schema: asciiString(source.schema, `${label} schema`),
    digest: digest(source.digest, `${label} digest`),
    parent_run_attempt: positiveInteger(source.parent_run_attempt, `${label} parent_run_attempt`),
    ...(withSourceAttempt
      ? {
          source_parent_run_attempt: positiveInteger(
            source.source_parent_run_attempt,
            `${label} source_parent_run_attempt`,
          ),
        }
      : {}),
  };
}

function validateSourceAttempts(value, attempt) {
  const sources = object(value, "release validation receipt source_attempts");
  exactKeys(
    sources,
    ["execution_plan", "decision", "diagnostic_drain"],
    "release validation receipt source_attempts",
  );
  const executionPlan = validateSourceAttempt(
    sources.execution_plan,
    "release validation receipt source_attempts execution_plan",
    false,
  );
  const decision = validateSourceAttempt(
    sources.decision,
    "release validation receipt source_attempts decision",
    true,
  );
  const diagnosticDrain = validateSourceAttempt(
    sources.diagnostic_drain,
    "release validation receipt source_attempts diagnostic_drain",
    true,
  );
  if (
    executionPlan.schema !== "openclaw.full-release-execution-plan.v1" ||
    decision.schema !== "openclaw.full-release-decision.v2" ||
    diagnosticDrain.schema !== "openclaw.full-release-diagnostic-drain.v2"
  ) {
    fail("release validation receipt source_attempts schema is unsupported");
  }
  if (
    decision.source_parent_run_attempt !== executionPlan.parent_run_attempt ||
    diagnosticDrain.source_parent_run_attempt !== executionPlan.parent_run_attempt
  ) {
    fail("release validation receipt state attempts must bind the execution plan attempt");
  }
  if (
    executionPlan.parent_run_attempt > attempt.run_attempt ||
    decision.parent_run_attempt > attempt.run_attempt ||
    diagnosticDrain.parent_run_attempt > attempt.run_attempt
  ) {
    fail("release validation receipt source attempt cannot exceed the receipt attempt");
  }
  return {
    execution_plan: executionPlan,
    decision,
    diagnostic_drain: diagnosticDrain,
  };
}

function validateGroups(value) {
  if (!Array.isArray(value) || value.length === 0) {
    fail("release validation receipt groups must be a non-empty array");
  }
  const groups = value.map((entry, index) => {
    const group = object(entry, `release validation receipt groups[${index}]`);
    exactKeys(group, ["id", "mode", "policy"], `release validation receipt groups[${index}]`);
    return {
      id: asciiString(group.id, `release validation receipt groups[${index}].id`),
      mode: enumString(group.mode, GROUP_MODES, `release validation receipt groups[${index}].mode`),
      policy: asciiString(group.policy, `release validation receipt groups[${index}].policy`),
    };
  });
  const ids = groups.map((group) => group.id);
  if (
    new Set(ids).size !== ids.length ||
    ids.some((id, index) => index > 0 && compareAscii(ids[index - 1], id) >= 0)
  ) {
    fail("release validation receipt groups must have unique ids in ascending ASCII order");
  }
  return groups;
}

function validateChildRuns(value, groups, tooling) {
  if (!Array.isArray(value) || value.length === 0) {
    fail("release validation receipt child_runs must be a non-empty array");
  }
  const groupIds = new Set(groups.map((group) => group.id));
  const children = value.map((entry, index) => {
    const child = object(entry, `release validation receipt child_runs[${index}]`);
    exactKeys(
      child,
      ["group", "workflow_path", "run_id", "run_attempt", "workflow_sha", "conclusion", "url"],
      `release validation receipt child_runs[${index}]`,
    );
    const result = {
      group: asciiString(child.group, `release validation receipt child_runs[${index}].group`),
      workflow_path: asciiString(
        child.workflow_path,
        `release validation receipt child_runs[${index}].workflow_path`,
      ),
      run_id: runId(child.run_id, `release validation receipt child_runs[${index}].run_id`),
      run_attempt: positiveInteger(
        child.run_attempt,
        `release validation receipt child_runs[${index}].run_attempt`,
      ),
      workflow_sha: sha(
        child.workflow_sha,
        `release validation receipt child_runs[${index}].workflow_sha`,
      ),
      conclusion: enumString(
        child.conclusion,
        RUN_CONCLUSIONS,
        `release validation receipt child_runs[${index}].conclusion`,
      ),
      url: actionUrl(child.url, `release validation receipt child_runs[${index}].url`),
    };
    if (!groupIds.has(result.group)) {
      fail(`release validation receipt child_runs[${index}] references an unknown group`);
    }
    if (result.workflow_sha !== tooling.sha) {
      fail(`release validation receipt child_runs[${index}] workflow SHA differs from tooling`);
    }
    if (!result.url.includes(`/actions/runs/${result.run_id}`)) {
      fail(`release validation receipt child_runs[${index}] URL must bind its run_id`);
    }
    return result;
  });
  const groupNames = children.map((child) => child.group);
  if (
    new Set(groupNames).size !== groupNames.length ||
    groupNames.some((group, index) => index > 0 && compareAscii(groupNames[index - 1], group) >= 0)
  ) {
    fail("release validation receipt child_runs must have one child per group in ASCII order");
  }
  if (groupNames.length !== groups.length || groupNames.some((group) => !groupIds.has(group))) {
    fail("release validation receipt child_runs must cover every declared group");
  }
  return children;
}

function validateObservedJobs(value, children) {
  if (!Array.isArray(value) || value.length === 0) {
    fail("release validation receipt observed_jobs must be a non-empty array");
  }
  const childByGroup = new Map(children.map((child) => [child.group, child]));
  const jobs = value.map((entry, index) => {
    const job = object(entry, `release validation receipt observed_jobs[${index}]`);
    exactKeys(
      job,
      ["group", "name", "policy", "status", "conclusion", "started_at", "completed_at", "url"],
      `release validation receipt observed_jobs[${index}]`,
    );
    const result = {
      group: asciiString(job.group, `release validation receipt observed_jobs[${index}].group`),
      name: asciiString(job.name, `release validation receipt observed_jobs[${index}].name`),
      policy: enumString(
        job.policy,
        JOB_POLICIES,
        `release validation receipt observed_jobs[${index}].policy`,
      ),
      status: asciiString(job.status, `release validation receipt observed_jobs[${index}].status`),
      conclusion: enumString(
        job.conclusion,
        RUN_CONCLUSIONS,
        `release validation receipt observed_jobs[${index}].conclusion`,
      ),
      started_at: nullableTimestamp(
        job.started_at,
        `release validation receipt observed_jobs[${index}].started_at`,
      ),
      completed_at: nullableTimestamp(
        job.completed_at,
        `release validation receipt observed_jobs[${index}].completed_at`,
      ),
      url: actionUrl(job.url, `release validation receipt observed_jobs[${index}].url`),
    };
    const child = childByGroup.get(result.group);
    if (!child) {
      fail(`release validation receipt observed_jobs[${index}] references an unknown group`);
    }
    if (result.status !== "completed") {
      fail(`release validation receipt observed_jobs[${index}] must be terminal`);
    }
    if (
      result.started_at !== null &&
      result.completed_at !== null &&
      Date.parse(result.started_at) > Date.parse(result.completed_at)
    ) {
      fail(`release validation receipt observed_jobs[${index}] timestamps are reversed`);
    }
    if (!result.url.includes(`/actions/runs/${child.run_id}`)) {
      fail(`release validation receipt observed_jobs[${index}] URL must bind its child run`);
    }
    return result;
  });
  const identities = jobs.map((job) => `${job.group}\0${job.name}`);
  if (
    new Set(identities).size !== identities.length ||
    identities.some(
      (identity, index) => index > 0 && compareAscii(identities[index - 1], identity) >= 0,
    )
  ) {
    fail("release validation receipt observed_jobs must be unique in group/name ASCII order");
  }
  for (const group of childByGroup.keys()) {
    if (!jobs.some((job) => job.group === group)) {
      fail(`release validation receipt observed_jobs omitted group: ${group}`);
    }
  }
  return jobs;
}

function validateSourceArtifacts(value, attempt, releasePlan, sourceAttempts) {
  if (!Array.isArray(value) || value.length < 4) {
    fail("release validation receipt source_artifacts must contain required source artifacts");
  }
  const artifacts = value.map((entry, index) => {
    const artifact = object(entry, `release validation receipt source_artifacts[${index}]`);
    exactKeys(
      artifact,
      [
        "kind",
        "artifact_id",
        "artifact_name",
        "entry_name",
        "run_id",
        "run_attempt",
        "archive_digest",
        "content_digest",
        "created_at",
      ],
      `release validation receipt source_artifacts[${index}]`,
    );
    return {
      kind: enumString(
        artifact.kind,
        SOURCE_ARTIFACT_KINDS,
        `release validation receipt source_artifacts[${index}].kind`,
      ),
      artifact_id: runId(
        artifact.artifact_id,
        `release validation receipt source_artifacts[${index}].artifact_id`,
      ),
      artifact_name: asciiString(
        artifact.artifact_name,
        `release validation receipt source_artifacts[${index}].artifact_name`,
      ),
      entry_name: asciiString(
        artifact.entry_name,
        `release validation receipt source_artifacts[${index}].entry_name`,
      ),
      run_id: runId(
        artifact.run_id,
        `release validation receipt source_artifacts[${index}].run_id`,
      ),
      run_attempt: positiveInteger(
        artifact.run_attempt,
        `release validation receipt source_artifacts[${index}].run_attempt`,
      ),
      archive_digest: digest(
        artifact.archive_digest,
        `release validation receipt source_artifacts[${index}].archive_digest`,
      ),
      content_digest: digest(
        artifact.content_digest,
        `release validation receipt source_artifacts[${index}].content_digest`,
      ),
      created_at: timestamp(
        artifact.created_at,
        `release validation receipt source_artifacts[${index}].created_at`,
      ),
    };
  });
  const identities = artifacts.map((artifact) => `${artifact.kind}\0${artifact.artifact_name}`);
  if (
    new Set(identities).size !== identities.length ||
    identities.some(
      (identity, index) => index > 0 && compareAscii(identities[index - 1], identity) >= 0,
    )
  ) {
    fail("release validation receipt source_artifacts must be unique in kind/name ASCII order");
  }
  const required = [
    ["execution-plan", sourceAttempts.execution_plan],
    ["decision", sourceAttempts.decision],
    ["diagnostic-drain", sourceAttempts.diagnostic_drain],
  ];
  for (const [kind, source] of required) {
    const matches = artifacts.filter((artifact) => artifact.kind === kind);
    if (
      matches.length !== 1 ||
      matches[0].run_id !== attempt.run_id ||
      matches[0].run_attempt !== source.parent_run_attempt ||
      matches[0].content_digest !== source.digest
    ) {
      fail(`release validation receipt source_artifacts ${kind} binding is invalid`);
    }
  }
  const planLocks = artifacts.filter((artifact) => artifact.kind === "release-plan-lock");
  if (planLocks.length !== 1 || planLocks[0].content_digest !== releasePlan.lock_digest) {
    fail("release validation receipt release-plan-lock artifact binding is invalid");
  }
  return artifacts;
}

function validateTimestamps(value, attempt, sourceArtifacts) {
  const timestamps = object(value, "release validation receipt timestamps");
  exactKeys(
    timestamps,
    ["started_at", "decision_at", "drain_completed_at", "sealed_at"],
    "release validation receipt timestamps",
  );
  const result = {
    started_at: timestamp(
      timestamps.started_at,
      "release validation receipt timestamps started_at",
    ),
    decision_at: timestamp(
      timestamps.decision_at,
      "release validation receipt timestamps decision_at",
    ),
    drain_completed_at: timestamp(
      timestamps.drain_completed_at,
      "release validation receipt timestamps drain_completed_at",
    ),
    sealed_at: timestamp(timestamps.sealed_at, "release validation receipt timestamps sealed_at"),
  };
  const ordered = [
    result.started_at,
    result.decision_at,
    result.drain_completed_at,
    result.sealed_at,
  ].map(Date.parse);
  if (ordered.some((entry, index) => index > 0 && ordered[index - 1] > entry)) {
    fail("release validation receipt timestamps must be chronological");
  }
  if (
    sourceArtifacts.some(
      (artifact) => Date.parse(artifact.created_at) > Date.parse(result.sealed_at),
    )
  ) {
    fail("release validation receipt cannot precede a source artifact");
  }
  if (!attempt.url.includes(`/actions/runs/${attempt.run_id}`)) {
    fail("release validation receipt timestamp attempt binding is invalid");
  }
  return result;
}

function validateLineage(value) {
  const lineage = object(value, "release validation receipt lineage");
  exactKeys(
    lineage,
    ["generation", "root_receipt_digest", "parent_receipt_digest"],
    "release validation receipt lineage",
  );
  const result = {
    generation: nonNegativeInteger(
      lineage.generation,
      "release validation receipt lineage generation",
    ),
    root_receipt_digest: nullableDigest(
      lineage.root_receipt_digest,
      "release validation receipt lineage root_receipt_digest",
    ),
    parent_receipt_digest: nullableDigest(
      lineage.parent_receipt_digest,
      "release validation receipt lineage parent_receipt_digest",
    ),
  };
  if (
    (result.generation === 0 &&
      (result.root_receipt_digest !== null || result.parent_receipt_digest !== null)) ||
    (result.generation > 0 &&
      (result.root_receipt_digest === null || result.parent_receipt_digest === null))
  ) {
    fail("release validation receipt lineage generation and digests disagree");
  }
  return result;
}

export function validateReleaseValidationReceipt(value) {
  const receipt = object(value, "release validation receipt");
  exactKeys(
    receipt,
    [
      "schema",
      "canonicalization",
      "target",
      "tooling",
      "attempt",
      "release_plan",
      "validation",
      "source_attempts",
      "groups",
      "child_runs",
      "observed_jobs",
      "source_artifacts",
      "timestamps",
      "lineage",
    ],
    "release validation receipt",
  );
  if (receipt.schema !== RELEASE_VALIDATION_RECEIPT_SCHEMA) {
    fail(`release validation receipt schema must be ${RELEASE_VALIDATION_RECEIPT_SCHEMA}`);
  }
  if (receipt.canonicalization !== RELEASE_PLAN_CANONICALIZATION) {
    fail(`release validation receipt canonicalization must be ${RELEASE_PLAN_CANONICALIZATION}`);
  }
  const target = validateTarget(receipt.target);
  const tooling = validateTooling(receipt.tooling);
  const attempt = validateAttempt(receipt.attempt, tooling);
  const releasePlan = validateReleasePlanBinding(receipt.release_plan);
  const validation = validateValidation(receipt.validation, releasePlan.purpose);
  const sourceAttempts = validateSourceAttempts(receipt.source_attempts, attempt);
  const groups = validateGroups(receipt.groups);
  const childRuns = validateChildRuns(receipt.child_runs, groups, tooling);
  const observedJobs = validateObservedJobs(receipt.observed_jobs, childRuns);
  const sourceArtifacts = validateSourceArtifacts(
    receipt.source_artifacts,
    attempt,
    releasePlan,
    sourceAttempts,
  );
  const timestamps = validateTimestamps(receipt.timestamps, attempt, sourceArtifacts);
  const lineage = validateLineage(receipt.lineage);
  const result = {
    schema: RELEASE_VALIDATION_RECEIPT_SCHEMA,
    canonicalization: RELEASE_PLAN_CANONICALIZATION,
    target,
    tooling,
    attempt,
    release_plan: releasePlan,
    validation,
    source_attempts: sourceAttempts,
    groups,
    child_runs: childRuns,
    observed_jobs: observedJobs,
    source_artifacts: sourceArtifacts,
    timestamps,
    lineage,
  };
  if (
    validation.policy.outcome === "passed" &&
    observedJobs.some((job) => job.policy === "blocking" && job.conclusion !== "success")
  ) {
    fail("release validation receipt passed outcome contains failed blocking evidence");
  }
  if (
    Buffer.byteLength(canonicalReleaseJson(result), "ascii") > RELEASE_VALIDATION_RECEIPT_MAX_BYTES
  ) {
    fail(`release validation receipt exceeds ${RELEASE_VALIDATION_RECEIPT_MAX_BYTES} bytes`);
  }
  return result;
}

export function canonicalReleaseValidationReceiptJson(value) {
  return canonicalReleaseJson(validateReleaseValidationReceipt(value));
}

export function releaseValidationReceiptDigest(value) {
  return releaseCanonicalDigest(validateReleaseValidationReceipt(value));
}

export function parseReleaseValidationReceiptJson(text) {
  return parseCanonicalReleaseJson(text, {
    label: "release validation receipt JSON",
    maxBytes: RELEASE_VALIDATION_RECEIPT_MAX_BYTES,
    validate: validateReleaseValidationReceipt,
  });
}

export function validateReleaseValidationReceiptLocator(value) {
  const envelope = object(value, "release validation receipt locator");
  exactKeys(
    envelope,
    ["schema", "canonicalization", "receipt_digest", "locator", "sealed_at"],
    "release validation receipt locator",
  );
  if (envelope.schema !== RELEASE_VALIDATION_RECEIPT_LOCATOR_SCHEMA) {
    fail(
      `release validation receipt locator schema must be ${RELEASE_VALIDATION_RECEIPT_LOCATOR_SCHEMA}`,
    );
  }
  if (envelope.canonicalization !== RELEASE_PLAN_CANONICALIZATION) {
    fail(
      `release validation receipt locator canonicalization must be ${RELEASE_PLAN_CANONICALIZATION}`,
    );
  }
  const locator = object(envelope.locator, "release validation receipt locator coordinates");
  exactKeys(
    locator,
    [
      "repository",
      "run_id",
      "run_attempt",
      "artifact_id",
      "artifact_name",
      "entry_name",
      "archive_digest",
    ],
    "release validation receipt locator coordinates",
  );
  const result = {
    schema: RELEASE_VALIDATION_RECEIPT_LOCATOR_SCHEMA,
    canonicalization: RELEASE_PLAN_CANONICALIZATION,
    receipt_digest: digest(
      envelope.receipt_digest,
      "release validation receipt locator receipt_digest",
    ),
    locator: {
      repository: asciiString(locator.repository, "release validation receipt locator repository"),
      run_id: runId(locator.run_id, "release validation receipt locator run_id"),
      run_attempt: positiveInteger(
        locator.run_attempt,
        "release validation receipt locator run_attempt",
      ),
      artifact_id: runId(locator.artifact_id, "release validation receipt locator artifact_id"),
      artifact_name: asciiString(
        locator.artifact_name,
        "release validation receipt locator artifact_name",
      ),
      entry_name: asciiString(locator.entry_name, "release validation receipt locator entry_name"),
      archive_digest: digest(
        locator.archive_digest,
        "release validation receipt locator archive_digest",
      ),
    },
    sealed_at: timestamp(envelope.sealed_at, "release validation receipt locator sealed_at"),
  };
  if (result.locator.repository !== REPOSITORY) {
    fail(`release validation receipt locator repository must be ${REPOSITORY}`);
  }
  if (result.locator.entry_name !== "release-validation-receipt.json") {
    fail("release validation receipt locator entry_name is unsupported");
  }
  if (
    result.locator.artifact_name !==
    `release-validation-receipt-${result.locator.run_id}-${result.locator.run_attempt}`
  ) {
    fail("release validation receipt locator artifact_name must bind its run and attempt");
  }
  if (
    Buffer.byteLength(canonicalReleaseJson(result), "ascii") >
    RELEASE_VALIDATION_RECEIPT_LOCATOR_MAX_BYTES
  ) {
    fail(
      `release validation receipt locator exceeds ${RELEASE_VALIDATION_RECEIPT_LOCATOR_MAX_BYTES} bytes`,
    );
  }
  return result;
}

export function createReleaseValidationReceiptLocator(receiptValue, locatorValue) {
  const receipt = validateReleaseValidationReceipt(receiptValue);
  const locator = object(locatorValue, "release validation receipt locator coordinates");
  const envelope = validateReleaseValidationReceiptLocator({
    schema: RELEASE_VALIDATION_RECEIPT_LOCATOR_SCHEMA,
    canonicalization: RELEASE_PLAN_CANONICALIZATION,
    receipt_digest: releaseValidationReceiptDigest(receipt),
    locator,
    sealed_at: receipt.timestamps.sealed_at,
  });
  if (
    envelope.locator.run_id !== receipt.attempt.run_id ||
    envelope.locator.run_attempt !== receipt.attempt.run_attempt
  ) {
    fail("release validation receipt locator attempt differs from its receipt");
  }
  return envelope;
}

export function validateReleaseValidationReceiptLocatorForReceipt(locatorValue, receiptValue) {
  const locator = validateReleaseValidationReceiptLocator(locatorValue);
  const receipt = validateReleaseValidationReceipt(receiptValue);
  if (
    locator.receipt_digest !== releaseValidationReceiptDigest(receipt) ||
    locator.locator.run_id !== receipt.attempt.run_id ||
    locator.locator.run_attempt !== receipt.attempt.run_attempt ||
    locator.sealed_at !== receipt.timestamps.sealed_at
  ) {
    fail("release validation receipt locator differs from its receipt");
  }
  return locator;
}

export function canonicalReleaseValidationReceiptLocatorJson(value) {
  return canonicalReleaseJson(validateReleaseValidationReceiptLocator(value));
}

export function parseReleaseValidationReceiptLocatorJson(text) {
  return parseCanonicalReleaseJson(text, {
    label: "release validation receipt locator JSON",
    maxBytes: RELEASE_VALIDATION_RECEIPT_LOCATOR_MAX_BYTES,
    validate: validateReleaseValidationReceiptLocator,
  });
}
