import { describe, expect, it } from "vitest";
import {
  buildControlUiAutomationPath,
  parseControlUiAutomationPath,
} from "./automation.runtime.js";

describe("buildControlUiAutomationPath", () => {
  it.each([
    ["settings", undefined, "/automations/nightly%2Edigest"],
    ["runs", "runs", "/automations/nightly%2Edigest/runs"],
    ["nested base path", undefined, "/control/automations/nightly%2Edigest"],
  ] as const)("builds the %s route", (_label, tab, expected) => {
    expect(
      buildControlUiAutomationPath("nightly.digest", {
        ...(tab ? { tab } : {}),
        ...(_label === "nested base path" ? { basePath: "/control/" } : {}),
      }),
    ).toBe(expected);
  });

  it("encodes opaque job ids as one safe path segment", () => {
    expect(buildControlUiAutomationPath("team/audit ~ daily")).toBe(
      "/automations/team%2Faudit%20~%20daily",
    );
  });

  it.each(["", " ", "\t"])("rejects the blank job id %j", (jobId) => {
    expect(buildControlUiAutomationPath(jobId)).toBeNull();
  });
});

describe("parseControlUiAutomationPath", () => {
  it("round-trips an encoded job route", () => {
    const path = buildControlUiAutomationPath("nightly.digest", { tab: "runs" });
    expect(path && parseControlUiAutomationPath(path)).toEqual({
      jobId: "nightly.digest",
      tab: "runs",
    });
  });
});
