import { describe, expect, it } from "vitest";
import {
  mayInjectAutonomousSourceTranscript,
  resolveSubagentMemoryContextMode,
} from "./memory-autonomous-run-policy.js";

describe("memory autonomous-run policy", () => {
  it("removes raw fork context while memory isolation is active", () => {
    expect(
      resolveSubagentMemoryContextMode({ requested: "fork", memoryIsolationActive: true }),
    ).toBe("isolated");
    expect(
      resolveSubagentMemoryContextMode({ requested: "isolated", memoryIsolationActive: true }),
    ).toBe("isolated");
  });

  it("does not inject a current session transcript into an isolated service run", () => {
    expect(
      mayInjectAutonomousSourceTranscript({ sessionTarget: "current", memoryIsolationActive: true }),
    ).toBe(false);
    expect(
      mayInjectAutonomousSourceTranscript({ sessionTarget: "isolated", memoryIsolationActive: true }),
    ).toBe(true);
  });

  it("preserves the legacy path until isolation is enabled", () => {
    expect(
      resolveSubagentMemoryContextMode({ requested: "fork", memoryIsolationActive: false }),
    ).toBe("fork");
    expect(
      mayInjectAutonomousSourceTranscript({ sessionTarget: "current", memoryIsolationActive: false }),
    ).toBe(true);
  });
});
