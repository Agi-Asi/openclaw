import { describe, expect, it } from "vitest";
import { assertAuthorizedHistoricalExecutionPlanChildren } from "../../scripts/validate-authorized-beta-focused-evidence.mts";

const expectedSelectedRuns = new Map([
  ["normalCi", "32644407381"],
  ["pluginPrerelease", "32645134710"],
  ["releaseChecks", "32645133620"],
  ["productPerformance", "32644407718"],
]);

function historicalChildren(): Array<Record<string, unknown>> {
  const workflowRef = "release-ci/eed27fdb88c0-1787493942617";
  const workflowSha = "eed27fdb88c0c60cb79c5b159a0284bd519271c2";
  // Mirrors the five children in full-release-execution-plan-32644377679.
  return [
    {
      dispatchName: "Dispatch CI",
      displayTitle: "CI full-release-validation-32644377679-1-ci",
      key: "normalCi",
      required: true,
      result: "success",
      runAttempt: 1,
      runId: "32644407381",
      selected: true,
      source: "fresh",
      url: "https://github.com/openclaw/openclaw/actions/runs/32644407381",
      workflow: "ci.yml",
      workflowRef,
      workflowSha,
    },
    {
      dispatchName: "Dispatch plugin prerelease",
      displayTitle: "Plugin Prerelease full-release-validation-32644377679-1-plugin-prerelease",
      key: "pluginPrerelease",
      required: true,
      result: "success",
      runAttempt: 1,
      runId: "32645134710",
      selected: true,
      source: "fresh",
      url: "https://github.com/openclaw/openclaw/actions/runs/32645134710",
      workflow: "plugin-prerelease.yml",
      workflowRef,
      workflowSha,
    },
    {
      dispatchName: "Dispatch release checks",
      displayTitle: "OpenClaw Release Checks full-release-validation-32644377679-1-release-checks",
      key: "releaseChecks",
      required: true,
      result: "success",
      runAttempt: 1,
      runId: "32645133620",
      selected: true,
      source: "fresh",
      url: "https://github.com/openclaw/openclaw/actions/runs/32645133620",
      workflow: "openclaw-release-checks.yml",
      workflowRef,
      workflowSha,
    },
    {
      dispatchName: "Dispatch npm Telegram E2E",
      displayTitle: "NPM Telegram Beta E2E full-release-validation-32644377679-1-npm-telegram",
      key: "npmTelegram",
      required: false,
      result: "skipped",
      runAttempt: null,
      runId: "",
      selected: false,
      source: "fresh",
      url: "",
      workflow: "npm-telegram-beta-e2e.yml",
      workflowRef,
      workflowSha,
    },
    {
      dispatchName: "Dispatch OpenClaw Performance",
      displayTitle: "OpenClaw Performance full-release-validation-32644377679-1",
      key: "productPerformance",
      required: true,
      result: "success",
      runAttempt: 1,
      runId: "32644407718",
      selected: true,
      source: "fresh",
      url: "https://github.com/openclaw/openclaw/actions/runs/32644407718",
      workflow: "openclaw-performance.yml",
      workflowRef,
      workflowSha,
    },
  ];
}

function replaceChild(
  key: string,
  replacement: Partial<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return historicalChildren().map((child) =>
    child.key === key ? { ...child, ...replacement } : child,
  );
}

describe("authorized beta focused historical execution plan", () => {
  it("accepts the exact five-child historical plan shape", () => {
    expect(() =>
      assertAuthorizedHistoricalExecutionPlanChildren(historicalChildren(), expectedSelectedRuns),
    ).not.toThrow();
  });

  it.each([
    ["selected skipped child", { selected: true }],
    ["required skipped child", { required: true }],
    ["non-skipped empty identity", { result: "success" }],
    ["non-null skipped attempt", { runAttempt: 1 }],
    ["non-empty skipped run id", { runId: "32640000000" }],
  ])("rejects a %s", (_name, replacement) => {
    expect(() =>
      assertAuthorizedHistoricalExecutionPlanChildren(
        replaceChild("npmTelegram", replacement),
        expectedSelectedRuns,
      ),
    ).toThrow("must be unselected, non-required, skipped");
  });

  it.each([
    ["unselected required child", { selected: false }, "must be selected"],
    ["non-required selected child", { required: false }, "must be required"],
    ["failed selected child", { result: "failure" }, "must have result success"],
    ["wrong selected attempt", { runAttempt: 2 }, "must use run attempt 1"],
    ["empty selected run id", { runId: "" }, "must be a non-empty string"],
    ["wrong selected run id", { runId: "32640000000" }, "must be run 32644407381"],
  ])("rejects a %s", (_name, replacement, message) => {
    expect(() =>
      assertAuthorizedHistoricalExecutionPlanChildren(
        replaceChild("normalCi", replacement),
        expectedSelectedRuns,
      ),
    ).toThrow(message);
  });

  it("rejects malformed, duplicate, unknown, and missing children", () => {
    expect(() =>
      assertAuthorizedHistoricalExecutionPlanChildren(
        [null, ...historicalChildren().slice(1)],
        expectedSelectedRuns,
      ),
    ).toThrow("child must be an object");

    const duplicate = historicalChildren();
    duplicate.push({ ...duplicate[0] });
    expect(() =>
      assertAuthorizedHistoricalExecutionPlanChildren(duplicate, expectedSelectedRuns),
    ).toThrow("child key normalCi must be unique");

    expect(() =>
      assertAuthorizedHistoricalExecutionPlanChildren(
        replaceChild("npmTelegram", { key: "unexpected" }),
        expectedSelectedRuns,
      ),
    ).toThrow("child key unexpected is not authorized");

    for (const key of ["releaseChecks", "npmTelegram"]) {
      expect(() =>
        assertAuthorizedHistoricalExecutionPlanChildren(
          historicalChildren().filter((child) => child.key !== key),
          expectedSelectedRuns,
        ),
      ).toThrow(`child ${key} is missing`);
    }
  });
});
