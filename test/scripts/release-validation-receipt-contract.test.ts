import { describe, expect, it } from "vitest";
import {
  canonicalReleaseValidationReceiptJson,
  canonicalReleaseValidationReceiptLocatorJson,
  createReleaseValidationReceiptLocator,
  parseReleaseValidationReceiptJson,
  parseReleaseValidationReceiptLocatorJson,
  RELEASE_VALIDATION_RECEIPT_LOCATOR_SCHEMA,
  RELEASE_VALIDATION_RECEIPT_SCHEMA,
  releaseValidationReceiptDigest,
  validateReleaseValidationReceiptLocatorForReceipt,
  validateReleaseValidationReceipt,
} from "../../scripts/release-validation-receipt-contract.mjs";

const TARGET_SHA = "a".repeat(40);
const TOOLING_SHA = "b".repeat(40);
const PLAN_DIGEST = `sha256:${"1".repeat(64)}`;
const LOCK_DIGEST = `sha256:${"2".repeat(64)}`;
const EXECUTION_PLAN_DIGEST = `sha256:${"3".repeat(64)}`;
const DECISION_DIGEST = `sha256:${"4".repeat(64)}`;
const DRAIN_DIGEST = `sha256:${"5".repeat(64)}`;

function sourceArtifact(
  kind: string,
  id: string,
  name: string,
  entryName: string,
  runAttempt: number,
  archiveCharacter: string,
  contentDigest: string,
) {
  return {
    kind,
    artifact_id: id,
    artifact_name: name,
    entry_name: entryName,
    run_id: "9001",
    run_attempt: runAttempt,
    archive_digest: `sha256:${archiveCharacter.repeat(64)}`,
    content_digest: contentDigest,
    created_at: "2026-08-21T10:40:00Z",
  };
}

function receiptFixture() {
  return {
    schema: RELEASE_VALIDATION_RECEIPT_SCHEMA,
    canonicalization: "ascii-sorted-compact-json-trailing-newline-v1",
    target: {
      repository: "openclaw/openclaw",
      ref: "refs/tags/v2026.8.1-beta.3",
      sha: TARGET_SHA,
    },
    tooling: {
      repository: "openclaw/openclaw",
      ref: "refs/tags/release-publish/bbbbbbbbbbbb-123",
      sha: TOOLING_SHA,
    },
    attempt: {
      workflow_path: ".github/workflows/full-release-validation.yml",
      workflow_name: "Full Release Validation",
      workflow_ref: "refs/tags/release-publish/bbbbbbbbbbbb-123",
      workflow_sha: TOOLING_SHA,
      run_id: "9001",
      run_attempt: 2,
      url: "https://github.com/openclaw/openclaw/actions/runs/9001/attempts/2",
    },
    release_plan: {
      schema: "openclaw.release-plan.v1",
      purpose: "beta-publish",
      plan_digest: PLAN_DIGEST,
      lock_digest: LOCK_DIGEST,
    },
    validation: {
      intent: "release-beta",
      profile: "beta",
      soak: false,
      policy: {
        id: "openclaw.release-validation-policy.v1",
        fail_fast: false,
        outcome: "passed",
      },
    },
    source_attempts: {
      execution_plan: {
        schema: "openclaw.full-release-execution-plan.v1",
        digest: EXECUTION_PLAN_DIGEST,
        parent_run_attempt: 1,
      },
      decision: {
        schema: "openclaw.full-release-decision.v2",
        digest: DECISION_DIGEST,
        parent_run_attempt: 2,
        source_parent_run_attempt: 1,
      },
      diagnostic_drain: {
        schema: "openclaw.full-release-diagnostic-drain.v2",
        digest: DRAIN_DIGEST,
        parent_run_attempt: 2,
        source_parent_run_attempt: 1,
      },
    },
    groups: [
      { id: "normal-ci", mode: "blocking", policy: "required-success" },
      { id: "performance", mode: "diagnostic", policy: "advisory-beta" },
      { id: "release-checks", mode: "blocking", policy: "required-success" },
    ],
    child_runs: [
      {
        group: "normal-ci",
        workflow_path: ".github/workflows/ci.yml",
        run_id: "9101",
        run_attempt: 1,
        workflow_sha: TOOLING_SHA,
        conclusion: "success",
        url: "https://github.com/openclaw/openclaw/actions/runs/9101",
      },
      {
        group: "performance",
        workflow_path: ".github/workflows/openclaw-performance.yml",
        run_id: "9102",
        run_attempt: 1,
        workflow_sha: TOOLING_SHA,
        conclusion: "failure",
        url: "https://github.com/openclaw/openclaw/actions/runs/9102",
      },
      {
        group: "release-checks",
        workflow_path: ".github/workflows/openclaw-release-checks.yml",
        run_id: "9103",
        run_attempt: 1,
        workflow_sha: TOOLING_SHA,
        conclusion: "success",
        url: "https://github.com/openclaw/openclaw/actions/runs/9103",
      },
    ],
    observed_jobs: [
      {
        group: "normal-ci",
        name: "test",
        policy: "blocking",
        status: "completed",
        conclusion: "success",
        started_at: "2026-08-21T09:01:00Z",
        completed_at: "2026-08-21T09:21:00Z",
        url: "https://github.com/openclaw/openclaw/actions/runs/9101/job/1",
      },
      {
        group: "performance",
        name: "bench",
        policy: "advisory",
        status: "completed",
        conclusion: "failure",
        started_at: "2026-08-21T09:02:00Z",
        completed_at: "2026-08-21T09:12:00Z",
        url: "https://github.com/openclaw/openclaw/actions/runs/9102/job/2",
      },
      {
        group: "release-checks",
        name: "package",
        policy: "blocking",
        status: "completed",
        conclusion: "success",
        started_at: "2026-08-21T09:03:00Z",
        completed_at: "2026-08-21T10:30:00Z",
        url: "https://github.com/openclaw/openclaw/actions/runs/9103/job/3",
      },
    ],
    source_artifacts: [
      sourceArtifact(
        "decision",
        "9201",
        "full-release-decision-9001-2",
        "full-release-decision.json",
        2,
        "6",
        DECISION_DIGEST,
      ),
      sourceArtifact(
        "diagnostic-drain",
        "9202",
        "full-release-diagnostics-9001-2",
        "full-release-diagnostic-manifest.json",
        2,
        "7",
        DRAIN_DIGEST,
      ),
      sourceArtifact(
        "execution-plan",
        "9203",
        "full-release-execution-plan-9001",
        "full-release-execution-plan.json",
        1,
        "8",
        EXECUTION_PLAN_DIGEST,
      ),
      sourceArtifact(
        "release-plan-lock",
        "9204",
        "release-plan-lock-9001",
        "release-plan-lock.json",
        2,
        "9",
        LOCK_DIGEST,
      ),
    ],
    timestamps: {
      started_at: "2026-08-21T09:00:00Z",
      decision_at: "2026-08-21T09:22:00Z",
      drain_completed_at: "2026-08-21T10:35:00Z",
      sealed_at: "2026-08-21T10:45:00Z",
    },
    lineage: {
      generation: 0,
      root_receipt_digest: null,
      parent_receipt_digest: null,
    },
  };
}

function locatorCoordinates() {
  return {
    repository: "openclaw/openclaw",
    run_id: "9001",
    run_attempt: 2,
    artifact_id: "9301",
    artifact_name: "release-validation-receipt-9001-2",
    entry_name: "release-validation-receipt.json",
    archive_digest: `sha256:${"a".repeat(64)}`,
  };
}

describe("release validation receipt contract", () => {
  it("canonicalizes, hashes, and parses one immutable receipt", () => {
    const fixture = receiptFixture();
    const canonical = canonicalReleaseValidationReceiptJson(fixture);
    expect(canonical.endsWith("\n")).toBe(true);
    expect(canonical.slice(0, -1)).toMatch(/^[\x20-\x7e]+$/u);
    expect(parseReleaseValidationReceiptJson(canonical)).toEqual(
      validateReleaseValidationReceipt(fixture),
    );
    expect(releaseValidationReceiptDigest(fixture)).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(
      releaseValidationReceiptDigest({
        ...fixture,
        target: { sha: TARGET_SHA, ref: fixture.target.ref, repository: fixture.target.repository },
      }),
    ).toBe(releaseValidationReceiptDigest(fixture));
    expect(
      releaseValidationReceiptDigest({
        ...fixture,
        target: { ...fixture.target, sha: "c".repeat(40) },
      }),
    ).not.toBe(releaseValidationReceiptDigest(fixture));
  });

  it("rejects duplicate, reordered, pretty, CRLF, and non-ASCII bytes", () => {
    const canonical = canonicalReleaseValidationReceiptJson(receiptFixture());
    const parsed = JSON.parse(canonical) as Record<string, unknown>;
    const duplicate = canonical.replace('{"attempt":', `{"attempt":{},"attempt":`);
    expect(() => parseReleaseValidationReceiptJson(duplicate)).toThrow("duplicate key");
    expect(() =>
      parseReleaseValidationReceiptJson(
        `${JSON.stringify({
          schema: parsed.schema,
          target: parsed.target,
          ...parsed,
        })}\n`,
      ),
    ).toThrow("canonical bytes");
    expect(() => parseReleaseValidationReceiptJson(`${JSON.stringify(parsed, null, 2)}\n`)).toThrow(
      "compact printable ASCII",
    );
    expect(() => parseReleaseValidationReceiptJson(canonical.replace(/\n$/u, "\r\n"))).toThrow(
      "exactly one trailing LF",
    );
    expect(() =>
      parseReleaseValidationReceiptJson(canonical.replace("normal-ci", "normal-cí")),
    ).toThrow("printable ASCII");
  });

  it("rejects unknown fields at every authority boundary", () => {
    const fixture = receiptFixture();
    expect(() => validateReleaseValidationReceipt({ ...fixture, latest: true })).toThrow(
      "receipt keys must be exactly",
    );
    expect(() =>
      validateReleaseValidationReceipt({
        ...fixture,
        attempt: { ...fixture.attempt, head_branch: "main" },
      }),
    ).toThrow("attempt keys must be exactly");
    expect(() =>
      validateReleaseValidationReceipt({
        ...fixture,
        validation: {
          ...fixture.validation,
          policy: { ...fixture.validation.policy, retry: true },
        },
      }),
    ).toThrow("policy keys must be exactly");
  });

  it("binds purpose, intent, profile, soak, target, and tooling", () => {
    const fixture = receiptFixture();
    expect(() =>
      validateReleaseValidationReceipt({
        ...fixture,
        validation: { ...fixture.validation, intent: "release-stable" },
      }),
    ).toThrow("does not allow validation intent");
    expect(() =>
      validateReleaseValidationReceipt({
        ...fixture,
        validation: { ...fixture.validation, profile: "full" },
      }),
    ).toThrow("profile assertion conflicts");
    expect(() =>
      validateReleaseValidationReceipt({
        ...fixture,
        target: { ...fixture.target, ref: "main" },
      }),
    ).toThrow("qualified branch or tag ref");
    expect(() =>
      validateReleaseValidationReceipt({
        ...fixture,
        child_runs: fixture.child_runs.map((child, index) =>
          index === 0 ? { ...child, workflow_sha: "c".repeat(40) } : child,
        ),
      }),
    ).toThrow("workflow SHA differs from tooling");
    expect(() =>
      validateReleaseValidationReceipt({
        ...fixture,
        attempt: { ...fixture.attempt, workflow_sha: "c".repeat(40) },
      }),
    ).toThrow("workflow identity differs from tooling");
  });

  it("binds execution plan, Decision, and Drain source attempts and artifacts", () => {
    const fixture = receiptFixture();
    expect(() =>
      validateReleaseValidationReceipt({
        ...fixture,
        source_attempts: {
          ...fixture.source_attempts,
          decision: {
            ...fixture.source_attempts.decision,
            source_parent_run_attempt: 2,
          },
        },
      }),
    ).toThrow("bind the execution plan attempt");
    expect(() =>
      validateReleaseValidationReceipt({
        ...fixture,
        source_attempts: {
          ...fixture.source_attempts,
          diagnostic_drain: {
            ...fixture.source_attempts.diagnostic_drain,
            parent_run_attempt: 3,
          },
        },
      }),
    ).toThrow("cannot exceed the receipt attempt");
    expect(() =>
      validateReleaseValidationReceipt({
        ...fixture,
        source_artifacts: fixture.source_artifacts.map((artifact) =>
          artifact.kind === "decision"
            ? { ...artifact, content_digest: `sha256:${"f".repeat(64)}` }
            : artifact,
        ),
      }),
    ).toThrow("decision binding is invalid");
    expect(() =>
      validateReleaseValidationReceipt({
        ...fixture,
        release_plan: { ...fixture.release_plan, lock_digest: `sha256:${"e".repeat(64)}` },
      }),
    ).toThrow("release-plan-lock artifact binding is invalid");
  });

  it("requires complete, sorted, unique group and job evidence", () => {
    const fixture = receiptFixture();
    expect(() =>
      validateReleaseValidationReceipt({
        ...fixture,
        groups: [...fixture.groups].reverse(),
      }),
    ).toThrow("ascending ASCII order");
    expect(() =>
      validateReleaseValidationReceipt({
        ...fixture,
        child_runs: fixture.child_runs.slice(1),
      }),
    ).toThrow("cover every declared group");
    expect(() =>
      validateReleaseValidationReceipt({
        ...fixture,
        observed_jobs: fixture.observed_jobs.map((job, index) =>
          index === 0 ? { ...job, status: "in_progress" } : job,
        ),
      }),
    ).toThrow("must be terminal");
    expect(() =>
      validateReleaseValidationReceipt({
        ...fixture,
        observed_jobs: [...fixture.observed_jobs, fixture.observed_jobs[0]],
      }),
    ).toThrow("unique in group/name ASCII order");
  });

  it("allows diagnostic failures but rejects a passed blocking failure", () => {
    const fixture = receiptFixture();
    expect(validateReleaseValidationReceipt(fixture).validation.policy.outcome).toBe("passed");
    expect(
      validateReleaseValidationReceipt({
        ...fixture,
        child_runs: fixture.child_runs.map((child) =>
          child.group === "release-checks" ? { ...child, conclusion: "failure" } : child,
        ),
      }).validation.policy.outcome,
    ).toBe("passed");
    expect(() =>
      validateReleaseValidationReceipt({
        ...fixture,
        observed_jobs: fixture.observed_jobs.map((job, index) =>
          index === 0 ? { ...job, conclusion: "failure" } : job,
        ),
      }),
    ).toThrow("failed blocking evidence");
  });

  it("requires chronological timestamps and coherent lineage", () => {
    const fixture = receiptFixture();
    expect(() =>
      validateReleaseValidationReceipt({
        ...fixture,
        timestamps: { ...fixture.timestamps, decision_at: "2026-08-21T08:59:59Z" },
      }),
    ).toThrow("timestamps must be chronological");
    expect(() =>
      validateReleaseValidationReceipt({
        ...fixture,
        lineage: {
          generation: 0,
          root_receipt_digest: `sha256:${"d".repeat(64)}`,
          parent_receipt_digest: null,
        },
      }),
    ).toThrow("generation and digests disagree");
    expect(
      validateReleaseValidationReceipt({
        ...fixture,
        lineage: {
          generation: 1,
          root_receipt_digest: `sha256:${"d".repeat(64)}`,
          parent_receipt_digest: `sha256:${"d".repeat(64)}`,
        },
      }).lineage.generation,
    ).toBe(1);
  });
});

describe("release validation receipt locator contract", () => {
  it("creates and parses a digest-bound locator envelope", () => {
    const receipt = receiptFixture();
    const locator = createReleaseValidationReceiptLocator(receipt, locatorCoordinates());
    expect(locator.schema).toBe(RELEASE_VALIDATION_RECEIPT_LOCATOR_SCHEMA);
    expect(locator.receipt_digest).toBe(releaseValidationReceiptDigest(receipt));
    const canonical = canonicalReleaseValidationReceiptLocatorJson(locator);
    expect(parseReleaseValidationReceiptLocatorJson(canonical)).toEqual(locator);
    expect(validateReleaseValidationReceiptLocatorForReceipt(locator, receipt)).toEqual(locator);
  });

  it("rejects locator attempt drift, unknown keys, and receipt digest tampering", () => {
    const receipt = receiptFixture();
    expect(() =>
      createReleaseValidationReceiptLocator(receipt, {
        ...locatorCoordinates(),
        run_attempt: 1,
        artifact_name: "release-validation-receipt-9001-1",
      }),
    ).toThrow("attempt differs from its receipt");
    expect(() =>
      createReleaseValidationReceiptLocator(receipt, {
        ...locatorCoordinates(),
        artifact_name: "release-validation-receipt-latest",
      }),
    ).toThrow("artifact_name must bind its run and attempt");
    const locator = createReleaseValidationReceiptLocator(receipt, locatorCoordinates());
    expect(() =>
      parseReleaseValidationReceiptLocatorJson(
        canonicalReleaseValidationReceiptLocatorJson({
          ...locator,
          locator: { ...locator.locator, mutable_latest: true },
        }),
      ),
    ).toThrow("coordinates keys must be exactly");
    const canonical = canonicalReleaseValidationReceiptLocatorJson(locator);
    const tampered = parseReleaseValidationReceiptLocatorJson(
      canonical.replace(locator.receipt_digest, `sha256:${"f".repeat(64)}`),
    );
    expect(() => validateReleaseValidationReceiptLocatorForReceipt(tampered, receipt)).toThrow(
      "differs from its receipt",
    );
  });
});
