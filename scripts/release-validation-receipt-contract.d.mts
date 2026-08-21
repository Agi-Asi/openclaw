import type {
  ReleaseValidationIntent,
  ReleaseValidationProfile,
  ReleaseValidationPurpose,
} from "./release-validation-intent.mjs";

export type ReleaseValidationReceiptDigest = `sha256:${string}`;
export type ReleaseValidationReceiptRunConclusion =
  | "action_required"
  | "cancelled"
  | "failure"
  | "neutral"
  | "skipped"
  | "stale"
  | "startup_failure"
  | "success"
  | "timed_out";

export type ReleaseValidationAttempt = {
  workflow_path: ".github/workflows/full-release-validation.yml";
  workflow_name: "Full Release Validation";
  workflow_ref: string;
  workflow_sha: string;
  run_id: string;
  run_attempt: number;
  url: string;
};

export type ReleaseValidationSourceAttempt = {
  schema: string;
  digest: ReleaseValidationReceiptDigest;
  parent_run_attempt: number;
  source_parent_run_attempt?: number;
};

export type ReleaseValidationReceipt = {
  schema: "openclaw.release-validation-receipt.v1";
  canonicalization: "ascii-sorted-compact-json-trailing-newline-v1";
  target: {
    repository: "openclaw/openclaw";
    ref: string;
    sha: string;
  };
  tooling: {
    repository: "openclaw/openclaw";
    ref: string;
    sha: string;
  };
  attempt: ReleaseValidationAttempt;
  release_plan: {
    schema: "openclaw.release-plan.v1";
    purpose: ReleaseValidationPurpose;
    plan_digest: ReleaseValidationReceiptDigest;
    lock_digest: ReleaseValidationReceiptDigest;
  };
  validation: {
    intent: ReleaseValidationIntent;
    profile: ReleaseValidationProfile;
    soak: boolean;
    policy: {
      id: "openclaw.release-validation-policy.v1";
      fail_fast: boolean;
      outcome: "blocked" | "orchestration-error" | "passed";
    };
  };
  source_attempts: {
    execution_plan: ReleaseValidationSourceAttempt;
    decision: Required<ReleaseValidationSourceAttempt>;
    diagnostic_drain: Required<ReleaseValidationSourceAttempt>;
  };
  groups: Array<{
    id: string;
    mode: "blocking" | "diagnostic";
    policy: string;
  }>;
  child_runs: Array<{
    group: string;
    workflow_path: string;
    run_id: string;
    run_attempt: number;
    workflow_sha: string;
    conclusion: ReleaseValidationReceiptRunConclusion;
    url: string;
  }>;
  observed_jobs: Array<{
    group: string;
    name: string;
    policy: "advisory" | "blocking";
    status: "completed";
    conclusion: ReleaseValidationReceiptRunConclusion;
    started_at: string | null;
    completed_at: string | null;
    url: string;
  }>;
  source_artifacts: Array<{
    kind:
      | "candidate"
      | "child-evidence"
      | "decision"
      | "diagnostic-drain"
      | "execution-plan"
      | "release-plan-lock"
      | "validation-manifest";
    artifact_id: string;
    artifact_name: string;
    entry_name: string;
    run_id: string;
    run_attempt: number;
    archive_digest: ReleaseValidationReceiptDigest;
    content_digest: ReleaseValidationReceiptDigest;
    created_at: string;
  }>;
  timestamps: {
    started_at: string;
    decision_at: string;
    drain_completed_at: string;
    sealed_at: string;
  };
  lineage: {
    generation: number;
    root_receipt_digest: ReleaseValidationReceiptDigest | null;
    parent_receipt_digest: ReleaseValidationReceiptDigest | null;
  };
};

export type ReleaseValidationReceiptLocator = {
  schema: "openclaw.release-validation-receipt-locator.v1";
  canonicalization: "ascii-sorted-compact-json-trailing-newline-v1";
  receipt_digest: ReleaseValidationReceiptDigest;
  locator: {
    repository: "openclaw/openclaw";
    run_id: string;
    run_attempt: number;
    artifact_id: string;
    artifact_name: string;
    entry_name: "release-validation-receipt.json";
    archive_digest: ReleaseValidationReceiptDigest;
  };
  sealed_at: string;
};

export const RELEASE_VALIDATION_RECEIPT_SCHEMA: "openclaw.release-validation-receipt.v1";
export const RELEASE_VALIDATION_RECEIPT_LOCATOR_SCHEMA: "openclaw.release-validation-receipt-locator.v1";
export const RELEASE_VALIDATION_POLICY_ID: "openclaw.release-validation-policy.v1";
export const RELEASE_VALIDATION_RECEIPT_MAX_BYTES: number;
export const RELEASE_VALIDATION_RECEIPT_LOCATOR_MAX_BYTES: number;
export function validateReleaseValidationReceipt(value: unknown): ReleaseValidationReceipt;
export function canonicalReleaseValidationReceiptJson(value: unknown): string;
export function releaseValidationReceiptDigest(value: unknown): ReleaseValidationReceiptDigest;
export function parseReleaseValidationReceiptJson(text: string): ReleaseValidationReceipt;
export function validateReleaseValidationReceiptLocator(
  value: unknown,
): ReleaseValidationReceiptLocator;
export function createReleaseValidationReceiptLocator(
  receiptValue: unknown,
  locatorValue: unknown,
): ReleaseValidationReceiptLocator;
export function validateReleaseValidationReceiptLocatorForReceipt(
  locatorValue: unknown,
  receiptValue: unknown,
): ReleaseValidationReceiptLocator;
export function canonicalReleaseValidationReceiptLocatorJson(value: unknown): string;
export function parseReleaseValidationReceiptLocatorJson(
  text: string,
): ReleaseValidationReceiptLocator;
