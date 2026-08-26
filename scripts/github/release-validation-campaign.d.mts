export type ReleaseValidationCampaignArtifact =
  | {
      schema: "openclaw.release-validation-campaign/v1";
      operation: "upsert";
      tag: string;
      stableTrain: string;
      releaseUrl: string;
      releaseCommit: string;
      guidanceMainSha: string;
      title: string;
      body: string;
    }
  | {
      schema: "openclaw.release-validation-campaign/v1";
      operation: "close";
      tag: string;
      stableTrain: string;
      releaseUrl: string;
    };

export function validateReleaseValidationCampaignArtifact(
  artifact: unknown,
  options?: {
    expectedTag?: string;
    expectedReleaseCommit?: string;
    expectedGuidanceMainSha?: string;
  },
): ReleaseValidationCampaignArtifact;

type ReleaseValidationGitHubMethod = (...args: never[]) => Promise<unknown>;

export function runReleaseValidationCampaignPublish(params: {
  github: {
    paginate: (...args: never[]) => Promise<unknown[]>;
    rest: {
      issues: {
        create: ReleaseValidationGitHubMethod;
        createComment: ReleaseValidationGitHubMethod;
        createLabel: ReleaseValidationGitHubMethod;
        get: ReleaseValidationGitHubMethod;
        getLabel: ReleaseValidationGitHubMethod;
        listForRepo: ReleaseValidationGitHubMethod;
        update: ReleaseValidationGitHubMethod;
      };
    };
  };
  context: { repo: { owner: string; repo: string } };
  core: { info(message: string): void; setOutput?(name: string, value: string): void };
  artifact: unknown;
  expectedTag?: string;
  expectedReleaseCommit?: string;
  expectedGuidanceMainSha?: string;
  campaignIssueNumber?: number;
}): Promise<{
  action: "create" | "update" | "close" | "noop";
  issueNumber: number | undefined;
  issueUrl: string | undefined;
}>;
