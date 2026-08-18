// @vitest-environment node
import { describe, expect, it } from "vitest";
import { resolveChatProjectionRunId } from "./tool-stream.ts";

describe("resolveChatProjectionRunId", () => {
  it("restores an active run from the reconnecting outbox request", () => {
    const reconnecting = {
      id: "reconnecting",
      text: "Current prompt",
      createdAt: 1,
      sendRunId: "run-restored",
      sendState: "waiting-reconnect" as const,
    };

    expect(
      resolveChatProjectionRunId({
        hasActiveRun: true,
        queue: [reconnecting],
      }),
    ).toBe("run-restored");
    expect(
      resolveChatProjectionRunId({
        hasActiveRun: false,
        queue: [reconnecting],
      }),
    ).toBeNull();
    expect(
      resolveChatProjectionRunId({
        localRunId: "run-local",
        hasActiveRun: true,
        queue: [reconnecting],
      }),
    ).toBe("run-local");
  });
});
