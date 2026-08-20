import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { applySystemAgentModelSelection } from "./setup-model-selection.js";

describe("applySystemAgentModelSelection", () => {
  it("updates the configured system owner without changing another configured agent", async () => {
    const config = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "beta" } },
        entries: {
          alpha: { model: "openai/gpt-5.5" },
          beta: { model: "openai/gpt-5.6-sol" },
        },
      },
    } satisfies OpenClawConfig;

    const result = await applySystemAgentModelSelection({ config, model: "openai/gpt-5.6-luna" });

    expect(result.agents?.entries?.alpha?.model).toBe("openai/gpt-5.5");
    expect(result.agents?.entries?.beta?.model).toBe("openai/gpt-5.6-luna");
  });

  it("rejects an unrepresentable explicit agent instead of updating main", async () => {
    const config = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: { main: {}, ops: {} },
      },
    } satisfies OpenClawConfig;

    await expect(
      applySystemAgentModelSelection({
        config,
        model: "openai/gpt-5.5",
        targetAgentId: "агент✨",
      }),
    ).rejects.toThrow('Could not resolve configured agent "агент✨".');
    expect(config.agents.entries.main).toEqual({});
  });

  it("clears stale harness pins in both model scopes for a native route", async () => {
    const config = {
      agents: {
        ownership: "explicit",
        defaults: {
          models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
          systemAgent: { agentId: "work" },
        },
        entries: {
          work: {
            model: "openai/gpt-5.5",
            models: {
              "openai/gpt-5.5": {
                alias: "primary",
                agentRuntime: { id: "codex" },
              },
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const result = await applySystemAgentModelSelection({ config, model: "openai/gpt-5.5" });

    expect(result.agents?.defaults?.models?.["openai/gpt-5.5"]?.agentRuntime).toBeUndefined();
    expect(result.agents?.entries?.work?.models?.["openai/gpt-5.5"]).toEqual({ alias: "primary" });
    expect(result.agents?.entries?.work?.model).toBe("openai/gpt-5.5");
  });

  it("pins the verified credential without creating a global visibility map", async () => {
    const result = await applySystemAgentModelSelection({
      config: {
        agents: {
          ownership: "explicit",
          defaults: { model: "openai/gpt-5.5", systemAgent: { agentId: "main" } },
          entries: { main: {} },
        },
      },
      model: "openai/gpt-5.5",
      authProfileId: "openai:verified",
    });

    expect(result.agents?.defaults?.model).toBe("openai/gpt-5.5@openai:verified");
    expect(result.agents?.defaults?.models).toBeUndefined();
  });
});
