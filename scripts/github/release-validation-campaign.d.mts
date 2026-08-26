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

type ReleaseValidationCampaignRepository = { owner: string; repo: string };

type ReleaseValidationCampaignIssue = {
  number: number;
  state: string;
  title: string;
  body: string | null;
  html_url: string;
  labels?: Array<string | { name?: string }>;
  pull_request?: object;
};

type ReleaseValidationCampaignIssueList = (
  params: ReleaseValidationCampaignRepository & {
    state: "open";
    labels: string;
    per_page: number;
  },
) => Promise<{ data: ReleaseValidationCampaignIssue[] }>;

type ReleaseValidationCampaignGitHub = {
  paginate(
    endpoint: ReleaseValidationCampaignIssueList,
    params: Parameters<ReleaseValidationCampaignIssueList>[0],
  ): Promise<ReleaseValidationCampaignIssue[]>;
  rest: {
    issues: {
      listForRepo: ReleaseValidationCampaignIssueList;
      get(
        params: ReleaseValidationCampaignRepository & { issue_number: number },
      ): Promise<{ data: ReleaseValidationCampaignIssue | undefined }>;
      getLabel(
        params: ReleaseValidationCampaignRepository & { name: string },
      ): Promise<{ data: object }>;
      createLabel(
        params: ReleaseValidationCampaignRepository & {
          name: string;
          color: string;
          description: string;
        },
      ): Promise<{ data: object }>;
      create(
        params: ReleaseValidationCampaignRepository & {
          title: string;
          body: string;
          labels: string[];
        },
      ): Promise<{ data: ReleaseValidationCampaignIssue }>;
      update(
        params: ReleaseValidationCampaignRepository & {
          issue_number: number;
          labels: string[];
          state: "open" | "closed";
          state_reason?: "completed";
          title?: string;
          body?: string;
        },
      ): Promise<{ data: ReleaseValidationCampaignIssue }>;
      createComment(
        params: ReleaseValidationCampaignRepository & { issue_number: number; body: string },
      ): Promise<{ data: object }>;
    };
  };
};

export function runReleaseValidationCampaignPublish(params: {
  github: ReleaseValidationCampaignGitHub;
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
