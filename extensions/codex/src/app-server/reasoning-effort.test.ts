import { describe, expect, it } from "vitest";
import { applyCachedCodexReasoningMetadata } from "./reasoning-effort.js";

const model = {
  provider: "openai",
  id: "gpt-5.6-luna",
  name: "GPT-5.6 Luna",
  api: "openai-responses",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
  compat: { supportsReasoningEffort: true },
} as const;

describe("applyCachedCodexReasoningMetadata", () => {
  it("carries provider-owned effort metadata from the cached selected route", () => {
    const resolved = applyCachedCodexReasoningMetadata({
      model: model as never,
      provider: "openai",
      modelId: "gpt-5.6-luna",
      catalog: {
        entries: [
          {
            provider: "OpenAI",
            id: "GPT-5.6-Luna",
            compat: { supportedReasoningEfforts: ["low", "medium", "high", "max"] },
          },
        ],
      },
    });

    expect(resolved).toMatchObject({
      api: "openai-responses",
      compat: {
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["low", "medium", "high", "max"],
      },
    });
  });

  it("leaves the model unchanged when the cached catalog has no matching route", () => {
    expect(
      applyCachedCodexReasoningMetadata({
        model: model as never,
        provider: "openai",
        modelId: "gpt-5.6-luna",
        catalog: {
          entries: [
            {
              provider: "openai",
              id: "gpt-5.6-sol",
              compat: { supportedReasoningEfforts: ["ultra"] },
            },
          ],
        },
      }),
    ).toBe(model);
  });
});
