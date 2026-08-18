// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  isCriticalObserverHealth,
  projectSessionObserverDigest,
  resolveChatPaneObserverRunId,
} from "./observer-digest.ts";

describe("projectSessionObserverDigest", () => {
  it("binds a session-row projection to its owning session", () => {
    expect(
      projectSessionObserverDigest("agent:main:projected", {
        runId: "run-1",
        revision: 2,
        updatedAt: 3,
        headline: "Projected",
        health: "on-track",
      }),
    ).toEqual({
      sessionKey: "agent:main:projected",
      runId: "run-1",
      revision: 2,
      updatedAt: 3,
      headline: "Projected",
      health: "on-track",
    });
  });
});

describe("isCriticalObserverHealth", () => {
  it("recognizes only health states that require operator attention", () => {
    expect(isCriticalObserverHealth("stuck")).toBe(true);
    expect(isCriticalObserverHealth("waiting-on-user")).toBe(true);
    expect(isCriticalObserverHealth("done")).toBe(false);
    expect(isCriticalObserverHealth("failed")).toBe(false);
  });
});

describe("resolveChatPaneObserverRunId", () => {
  it("rejects an active-row digest without a local identity owner", () => {
    expect(
      resolveChatPaneObserverRunId({
        localRunId: null,
        session: { hasActiveRun: true },
        digest: { runId: "run-stale" },
      }),
    ).toBeNull();
  });

  it.each([
    {
      name: "locally tracked start",
      trackedRunIds: new Set(["run-current"]),
    },
    {
      name: "history in-flight snapshot recorded in the tracker",
      trackedRunIds: new Set(["run-current"]),
    },
  ])("accepts a digest owned by the $name", ({ trackedRunIds }) => {
    expect(
      resolveChatPaneObserverRunId({
        localRunId: null,
        session: { hasActiveRun: true },
        digest: { runId: "run-current" },
        trackedRunIds,
      }),
    ).toBe("run-current");
  });
});
