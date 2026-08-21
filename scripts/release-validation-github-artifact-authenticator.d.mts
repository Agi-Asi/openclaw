import type {
  ReleaseValidationSourceArtifact,
  ReleaseValidationVerifiedArtifactEvidence,
} from "./release-validation-receipt-contract.mjs";

export type GitHubReleaseValidationArtifactEvidence = ReleaseValidationSourceArtifact & {
  entry_bytes: string;
};

export type GitHubReleaseValidationArtifactExpected = {
  repository: string;
  workflowPath: string;
  workflowSha: string;
};

export function authenticateGitHubReleaseValidationArtifact(params: {
  evidence: GitHubReleaseValidationArtifactEvidence;
  expected: GitHubReleaseValidationArtifactExpected;
  artifactMetadata: unknown;
  workflowRun: unknown;
  archiveBytes: Uint8Array;
  nowMs: number;
}): ReleaseValidationVerifiedArtifactEvidence;

export function downloadAndAuthenticateGitHubReleaseValidationArtifact(params: {
  evidence: GitHubReleaseValidationArtifactEvidence;
  expected: GitHubReleaseValidationArtifactExpected & {
    artifactSizeBytes: number;
    runStatePolicy: "completed-success" | "same-run-producer-success";
    workflowEvent: string;
    workflowHeadBranch: string;
    consumerRunAttempt?: number;
    producerJobName?: string;
  };
  token: string;
  nowMs: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retryAttempts?: number;
  retryDelayMs?: number;
}): Promise<ReleaseValidationVerifiedArtifactEvidence>;
