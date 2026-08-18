import { describe, expect, it } from "vitest";
import { resolveChatSessionRunError } from "./chat-session-run-error.ts";

describe("resolveChatSessionRunError", () => {
  it("prefers a durable terminal error after reconnect", () => {
    expect(
      resolveChatSessionRunError(
        {
          key: "agent:main:failed",
          kind: "direct",
          status: "failed",
          lastRunError: "  LLM request timed out.  ",
        },
        "worker stopped",
      ),
    ).toEqual({ summary: "LLM request timed out." });
  });

  it("does not surface stale errors from non-terminal sessions", () => {
    expect(
      resolveChatSessionRunError(
        {
          key: "agent:main:working",
          kind: "direct",
          status: "running",
          lastRunError: "old failure",
        },
        undefined,
      ),
    ).toBeNull();
  });

  it("falls back to the placement terminal reason", () => {
    expect(resolveChatSessionRunError(undefined, "worker stopped")).toEqual({
      summary: "Cloud worker failed: worker stopped",
    });
  });
});
