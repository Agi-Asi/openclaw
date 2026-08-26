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

type CampaignIssue = {
  number: number;
  state: string;
  title: string;
  body?: string | null;
  html_url: string;
  labels?: Array<string | { name?: string | null }>;
  pull_request?: unknown;
};

type RepositoryRequest = {
  owner: string;
  repo: string;
};

type IssuesResponse<T> = Promise<{ data: T }>;

type ReleaseValidationGitHub = {
  paginate(
    method: (params: RepositoryRequest) => IssuesResponse<unknown>,
    params: RepositoryRequest,
  ): Promise<CampaignIssue[]>;
  rest: {
    issues: {
      listForRepo(params: RepositoryRequest): IssuesResponse<unknown>;
      getLabel(params: RepositoryRequest & { name: string }): IssuesResponse<unknown>;
      createLabel(
        params: RepositoryRequest & { name: string; color: string; description: string },
      ): IssuesResponse<unknown>;
      createComment(
        params: RepositoryRequest & { issue_number: number; body: string },
      ): IssuesResponse<unknown>;
      create(
        params: RepositoryRequest & { title: string; body: string; labels: string[] },
      ): IssuesResponse<CampaignIssue>;
      update(
        params: RepositoryRequest & { issue_number: number } & Record<string, unknown>,
      ): IssuesResponse<CampaignIssue>;
      get(
        params: RepositoryRequest & { issue_number: number },
      ): IssuesResponse<CampaignIssue | undefined>;
    };
  };
};

export function validateReleaseValidationCampaignArtifact(
  artifact: unknown,
  options?: {
    expectedTag?: string;
    expectedReleaseCommit?: string;
    expectedGuidanceMainSha?: string;
  },
): ReleaseValidationCampaignArtifact;

export function runReleaseValidationCampaignPublish(params: {
  github: ReleaseValidationGitHub;
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
