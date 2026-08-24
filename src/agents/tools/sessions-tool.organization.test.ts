import { describe, expect, it, vi } from "vitest";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import { createSessionsTool } from "./sessions-tool.js";

type AgentToolGatewayRequest = Parameters<AgentToolGatewayRequestCaller>[0];

describe("sessions organization", () => {
  it("patches visible sessions in one compact batch result", async () => {
    const callGateway = vi.fn(async (request: AgentToolGatewayRequest) => {
      if (request.method === "sessions.patchMany") {
        return {
          outcomes: [
            { ok: true, key: "agent:main:main" },
            {
              ok: false,
              key: "agent:main:dashboard:changed",
              error: { code: "INVALID_REQUEST", message: "session changed; retry" },
            },
          ],
        };
      }
      return { key: "agent:main:dashboard:changed" };
    });
    const tool = createSessionsTool({
      agentSessionKey: "agent:main:main",
      agentSessionId: "main-session",
      config: { tools: { sessions: { visibility: "all" } } },
      callGateway: callGateway as never,
    });

    const result = await tool.execute("batch-category", {
      action: "patch_many",
      targets: [{ sessionKey: "agent:main:main" }, { sessionKey: "agent:main:dashboard:changed" }],
      category: "Research",
      unread: false,
    });

    expect(callGateway).toHaveBeenCalledWith({
      method: "sessions.patchMany",
      params: {
        targets: [
          { key: "agent:main:main", expectedSessionId: "main-session" },
          { key: "agent:main:dashboard:changed" },
        ],
        patch: { category: "Research", unread: false },
      },
    });
    expect(result.details).toEqual({
      status: "partial",
      requested: 2,
      updated: 1,
      failed: [{ sessionKey: "agent:main:dashboard:changed", error: "session changed; retry" }],
    });

    await expect(
      tool.execute("batch-unsupported", {
        action: "patch_many",
        targets: [{ sessionKey: "agent:main:main" }],
        category: "Research",
        archived: true,
      }),
    ).rejects.toThrow("patch_many does not support archived");
    await expect(
      tool.execute("batch-stale-current", {
        action: "patch_many",
        targets: [{ sessionKey: "agent:main:main", expectedSessionId: "stale-session" }],
        unread: false,
      }),
    ).rejects.toThrow("Session changed after access was granted");
  });

  it("bounds failed batch details", async () => {
    const targetKey = "agent:main:dashboard:scoped";
    const callGateway = vi.fn(async (request: AgentToolGatewayRequest) => {
      if (request.method === "sessions.patchMany") {
        return {
          outcomes: Array.from({ length: 100 }, (_, index) => ({
            ok: false,
            key: `${targetKey}:${index}:${"k".repeat(200)}`,
            error: { code: "INVALID_REQUEST", message: "e".repeat(1_000) },
          })),
        };
      }
      return { key: targetKey };
    });
    const tool = createSessionsTool({
      agentSessionKey: "agent:main:main",
      config: { tools: { sessions: { visibility: "all" } } },
      callGateway: callGateway as never,
    });

    const result = await tool.execute("batch-bounded", {
      action: "patch_many",
      targets: [{ sessionKey: targetKey, expectedSessionId: "scoped-session" }],
      unread: false,
    });

    expect(result.details).toEqual({
      status: "failed",
      requested: 1,
      updated: 0,
      failedOmitted: { count: 100, reason: "response_budget_exceeded" },
    });
    const text = (result.content[0] as { text?: string } | undefined)?.text ?? "";
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(512);
  });
});
