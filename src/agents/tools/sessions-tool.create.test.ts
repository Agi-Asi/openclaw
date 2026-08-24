import { describe, expect, it, vi } from "vitest";
import { revokeCronCreatorAuthorityRunScope } from "../../gateway/cron-creator-authority-grant.js";
import { createSessionVisibilityChecker } from "../../plugin-sdk/session-visibility.js";
import {
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../cron-creator-authority-context.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import { createSessionsTool } from "./sessions-tool.js";

type GatewayRequest = Parameters<AgentToolGatewayRequestCaller>[0];

describe("sessions tool detached creation", () => {
  it("exposes create only during an admitted operator turn", async () => {
    const unavailable = createSessionsTool({ agentSessionKey: "agent:main:main", runId: "run" });
    const action = (unavailable.parameters as { properties: { action: { enum: string[] } } })
      .properties.action;
    expect(action.enum).not.toContain("create");

    const authority = createCronCreatorAuthorityCapability("run", {
      kind: "external",
      channel: "discord",
    })!;
    await runWithCronCreatorAuthorityCapability(authority, async () => {
      const tool = createSessionsTool({ agentSessionKey: "agent:main:main", runId: "run" });
      expect(tool.parameters).toMatchObject({
        properties: {
          action: { enum: expect.arrayContaining(["create"]) },
          permissionMode: { enum: ["read-only", "guarded", "workspace"] },
        },
      });
      expect(tool.parameters).not.toHaveProperty("properties.parentSessionKey");
      expect(tool.parameters).not.toHaveProperty("properties.fork");
    });
  });

  it("creates a full detached session with live local admin authority", async () => {
    let request: GatewayRequest | undefined;
    const callGateway: AgentToolGatewayRequestCaller = async <T>(next: GatewayRequest) => {
      request = next;
      next.sessionCreation?.detachedAuthority?.assertActive();
      return {
        ok: true,
        key: "agent:research:dashboard:detached",
        sessionId: "detached-session",
      } as T;
    };
    const authority = createCronCreatorAuthorityCapability("admin-run", { kind: "local" })!;

    await runWithCronCreatorAuthorityCapability(authority, async () => {
      const tool = createSessionsTool({
        agentSessionKey: "agent:main:main",
        requesterAgentIdOverride: "main",
        runId: "admin-run",
        config: { tools: { agentToAgent: { enabled: true } } },
        callGateway,
      });
      const result = await tool.execute("create-detached", {
        action: "create",
        agentId: "research",
        label: "Research",
        permissionMode: "full",
      });

      expect(request).toMatchObject({
        method: "sessions.create",
        params: { agentId: "research", label: "Research", permissionMode: "full" },
        sessionCreation: {
          via: "operator",
          actor: { type: "agent", id: "main" },
          detachedAuthority: { admin: true },
        },
      });
      expect(result.details).toEqual({
        status: "created",
        key: "agent:research:dashboard:detached",
        sessionId: "detached-session",
        mode: "full",
        nextStep: "Use sessions_send with this key to start work in the detached session.",
      });
      expect(
        createSessionVisibilityChecker.resolveScopedAccess({
          action: "send",
          requesterSessionKey: "agent:main:main",
          targetSessionKey: "agent:research:dashboard:detached",
        }),
      ).toEqual({ expectedSessionId: "detached-session" });
    });
    expect(
      createSessionVisibilityChecker.resolveScopedAccess({
        action: "send",
        requesterSessionKey: "agent:main:main",
        targetSessionKey: "agent:research:dashboard:detached",
      }),
    ).toBeUndefined();
  });

  it("returns the committed receipt when authority closes with the gateway response", async () => {
    const authority = createCronCreatorAuthorityCapability("run", { kind: "local" })!;
    const callGateway: AgentToolGatewayRequestCaller = async <T>() => {
      revokeCronCreatorAuthorityRunScope(authority);
      return { ok: true, key: "agent:main:dashboard:committed", sessionId: "committed" } as T;
    };

    await runWithCronCreatorAuthorityCapability(authority, async () => {
      const tool = createSessionsTool({
        agentSessionKey: "agent:main:main",
        runId: "run",
        callGateway,
      });
      await expect(tool.execute("create", { action: "create" })).resolves.toMatchObject({
        details: { status: "created", sessionId: "committed" },
      });
    });
  });

  it("rejects full creation without real admin authority", async () => {
    const callGateway = vi.fn();
    const authority = createCronCreatorAuthorityCapability("run", {
      kind: "external",
      channel: "discord",
    })!;
    await runWithCronCreatorAuthorityCapability(authority, async () => {
      const tool = createSessionsTool({
        agentSessionKey: "agent:main:main",
        runId: "run",
        callGateway,
      });
      await expect(
        tool.execute("create-full", { action: "create", permissionMode: "full" }),
      ).rejects.toThrow("Ask an administrator to create a full session");
    });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("keeps cross-agent creation behind the agent-to-agent policy", async () => {
    const callGateway = vi.fn();
    const authority = createCronCreatorAuthorityCapability("run", { kind: "local" })!;
    await runWithCronCreatorAuthorityCapability(authority, async () => {
      const tool = createSessionsTool({
        agentSessionKey: "agent:main:main",
        requesterAgentIdOverride: "main",
        runId: "run",
        callGateway,
      });
      await expect(
        tool.execute("cross-agent", { action: "create", agentId: "research" }),
      ).rejects.toThrow("Cross-agent session creation requires tools.agentToAgent.enabled");
    });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("expires a retained create tool when admitted authority closes", async () => {
    const callGateway = vi.fn();
    const authority = createCronCreatorAuthorityCapability("run", { kind: "local" })!;
    let retained: ReturnType<typeof createSessionsTool> | undefined;
    await runWithCronCreatorAuthorityCapability(authority, async () => {
      retained = createSessionsTool({
        agentSessionKey: "agent:main:main",
        runId: "run",
        callGateway,
      });
    });

    await expect(
      retained?.execute("stale-create", { action: "create", permissionMode: "guarded" }),
    ).rejects.toThrow("authority is no longer active");
    expect(callGateway).not.toHaveBeenCalled();
  });
});
