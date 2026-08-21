import { describe, expect, it, vi } from "vitest";
import {
  validateReleaseToolingIdentity,
  verifyReleaseToolingIdentity,
} from "../../scripts/release-tooling-identity.mjs";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const RUN_ID = "12345";
const REF = `release-publish/${SHA.slice(0, 12)}-${RUN_ID}`;
const FULL_REF = `refs/tags/${REF}`;

function protectedIdentity(
  overrides: Partial<Parameters<typeof verifyReleaseToolingIdentity>[0]> = {},
) {
  return {
    releasePublishRunId: RUN_ID,
    repository: "openclaw/openclaw",
    workflowFullRef: FULL_REF,
    workflowRef: REF,
    workflowSha: SHA,
    ...overrides,
  };
}

describe("release tooling identity", () => {
  it("accepts only the live exact lightweight protected tag", () => {
    const runGh = vi.fn(() =>
      JSON.stringify({
        ref: FULL_REF,
        object: { sha: SHA, type: "commit" },
      }),
    );

    expect(verifyReleaseToolingIdentity({ ...protectedIdentity(), runGh })).toEqual({
      fullRef: FULL_REF,
      ref: REF,
      releasePublishRunId: RUN_ID,
      route: "protected-tag",
      sha: SHA,
    });
    expect(runGh).toHaveBeenCalledWith([
      "api",
      `repos/openclaw/openclaw/git/ref/tags/${REF}`,
      "--method",
      "GET",
    ]);
  });

  it.each([
    [
      "moved tag",
      {
        runGh: () =>
          JSON.stringify({
            ref: FULL_REF,
            object: { sha: OTHER_SHA, type: "commit" },
          }),
      },
      "missing, moved, annotated, or bound to the wrong SHA",
    ],
    [
      "deleted tag",
      {
        runGh: () => {
          throw new Error("HTTP 404");
        },
      },
      "missing or unreadable",
    ],
    [
      "annotated tag",
      {
        runGh: () =>
          JSON.stringify({
            ref: FULL_REF,
            object: { sha: OTHER_SHA, type: "tag" },
          }),
      },
      "missing, moved, annotated, or bound to the wrong SHA",
    ],
    [
      "wrong SHA prefix",
      {
        workflowRef: `release-publish/${OTHER_SHA.slice(0, 12)}-${RUN_ID}`,
        workflowFullRef: `refs/tags/release-publish/${OTHER_SHA.slice(0, 12)}-${RUN_ID}`,
      },
      "SHA prefix does not match",
    ],
    ["wrong release run", { releasePublishRunId: "54321" }, "run does not match"],
    ["same-name branch", { workflowFullRef: `refs/heads/${REF}` }, "exact tag full ref"],
  ])("rejects $0", (_label, overrides, expectedError) => {
    expect(() =>
      verifyReleaseToolingIdentity({
        ...protectedIdentity(),
        ...overrides,
      }),
    ).toThrow(expectedError);
  });

  it.each(["ahead", "identical"])(
    "accepts main tooling reachable from current main: %s",
    (status) => {
      const runGh = vi.fn(() => JSON.stringify({ status }));
      expect(
        verifyReleaseToolingIdentity({
          repository: "openclaw/openclaw",
          runGh,
          workflowFullRef: "refs/heads/main",
          workflowRef: "main",
          workflowSha: SHA,
        }),
      ).toMatchObject({ route: "main", sha: SHA });
    },
  );

  it("rejects main tooling outside current main ancestry", () => {
    expect(() =>
      validateReleaseToolingIdentity({
        mainComparisonStatus: "diverged",
        workflowFullRef: "refs/heads/main",
        workflowRef: "main",
        workflowSha: SHA,
      }),
    ).toThrow("not reachable from current main");
  });

  it("preserves explicitly prevalidated non-main branch routes", () => {
    expect(
      verifyReleaseToolingIdentity({
        allowPrevalidatedRef: true,
        repository: "openclaw/openclaw",
        runGh: vi.fn(() => {
          throw new Error("prevalidated branches do not require a remote identity query");
        }),
        workflowFullRef: "refs/heads/release/2026.8.1",
        workflowRef: "release/2026.8.1",
        workflowSha: SHA,
      }),
    ).toMatchObject({ route: "prevalidated-branch" });
  });
});
