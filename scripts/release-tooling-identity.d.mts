export type ReleaseToolingIdentity = {
  fullRef: string;
  ref: string;
  releasePublishRunId?: string;
  route: "main" | "prevalidated-branch" | "protected-tag";
  sha: string;
};

export type ReleaseToolingIdentityInput = {
  allowPrevalidatedRef?: boolean;
  releasePublishRunId?: string;
  workflowFullRef: string;
  workflowRef: string;
  workflowSha: string;
};

export function validateReleaseToolingIdentity(
  input: ReleaseToolingIdentityInput & {
    mainComparisonStatus?: unknown;
    tagRef?: unknown;
  },
): ReleaseToolingIdentity;

export function verifyReleaseToolingIdentity(
  input: ReleaseToolingIdentityInput & {
    repository: string;
    runGh?: (args: string[]) => string;
  },
): ReleaseToolingIdentity;
