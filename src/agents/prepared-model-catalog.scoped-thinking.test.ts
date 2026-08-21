// Boundary proof for the turn-path thinking fallback: manifest first, then a provider-scoped
// static catalog, then scoped live discovery only for runtime-only models (e.g. Ollama).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshot } from "../config/plugin-auto-enable.test-helpers.js";
import { PreparedModelRuntimeOwnerNotPublishedError } from "./prepared-model-runtime.errors.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.types.js";

const manifestCatalogMock = vi.fn((..._args: unknown[]): Array<Record<string, unknown>> => []);
const scopedStaticMock = vi.fn(
  async (..._args: unknown[]): Promise<Record<string, unknown>> => ({
    entries: [],
    routeVariants: [],
  }),
);
const scopedLiveMock = vi.fn(
  async (..._args: unknown[]): Promise<Record<string, unknown>> => ({
    entries: [],
    routeVariants: [],
  }),
);
const publishedSnapshotMock = vi.fn((..._args: unknown[]) => undefined as unknown);
const preparedSnapshotMock = vi.fn<
  (input: { agentDir: string }) => Promise<PreparedModelRuntimeSnapshot>
>(async (input) => {
  throw new PreparedModelRuntimeOwnerNotPublishedError(
    `not published for test (${input.agentDir})`,
  );
});

vi.mock("./model-catalog.js", () => ({
  loadManifestModelCatalog: (...args: unknown[]) => manifestCatalogMock(...args),
}));

vi.mock("./prepared-model-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./prepared-model-runtime.js")>();
  return {
    ...actual,
    getPreparedModelRuntimeSnapshot: (...args: unknown[]) => publishedSnapshotMock(...args),
    // No published lifecycle owner: force the scoped read-only builders to run.
    prepareModelRuntimeSnapshot: (...args: Parameters<typeof preparedSnapshotMock>) =>
      preparedSnapshotMock(...args),
  };
});

vi.mock("./prepared-model-runtime.scoped-catalog.js", () => ({
  prepareScopedReadOnlyModelCatalog: (...args: unknown[]) => scopedStaticMock(...args),
  prepareScopedReadOnlyLiveModelCatalog: (...args: unknown[]) => scopedLiveMock(...args),
}));

const ollamaEntry = {
  provider: "ollama",
  id: "minimax-m3:cloud",
  name: "minimax-m3:cloud",
  reasoning: true,
};

describe("loadProviderScopedThinkingCatalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    manifestCatalogMock.mockReturnValue([]);
    scopedStaticMock.mockResolvedValue({ entries: [], routeVariants: [] });
    scopedLiveMock.mockResolvedValue({ entries: [], routeVariants: [] });
    publishedSnapshotMock.mockReturnValue(undefined);
    preparedSnapshotMock.mockImplementation(async (input) => {
      throw new PreparedModelRuntimeOwnerNotPublishedError(
        `not published for test (${input.agentDir})`,
      );
    });
  });

  it("prefers the published prepared generation over partial manifest compatibility", async () => {
    manifestCatalogMock.mockReturnValue([
      {
        provider: "openai",
        id: "gpt-5.6-sol",
        reasoning: true,
        compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
      },
    ]);
    publishedSnapshotMock.mockImplementation((input: unknown) => ({
      config: (input as { config: unknown }).config,
      modelCatalog: {
        entries: [
          {
            provider: "openai",
            id: "gpt-5.6-sol",
            reasoning: true,
            compat: {
              supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
            },
          },
        ],
        routeVariants: [],
      },
    }));
    const { loadProviderScopedThinkingCatalog } = await import("./prepared-model-catalog.js");

    const catalog = await loadProviderScopedThinkingCatalog({
      config: {},
      provider: "openai",
      model: "gpt-5.6-sol",
    });

    expect(catalog[0]?.compat?.supportedReasoningEfforts).toContain("ultra");
    expect(scopedStaticMock).not.toHaveBeenCalled();
    expect(scopedLiveMock).not.toHaveBeenCalled();
  });

  it("resolves manifest-backed models without any scoped catalog build", async () => {
    manifestCatalogMock.mockReturnValue([
      { provider: "openai", id: "gpt-5.6-luna", reasoning: true },
    ]);
    const { loadProviderScopedThinkingCatalog } = await import("./prepared-model-catalog.js");
    const catalog = await loadProviderScopedThinkingCatalog({
      config: {},
      provider: "openai",
      model: "gpt-5.6-luna",
    });
    expect(catalog).toEqual([
      expect.objectContaining({ provider: "openai", id: "gpt-5.6-luna", reasoning: true }),
    ]);
    expect(scopedStaticMock).not.toHaveBeenCalled();
    expect(scopedLiveMock).not.toHaveBeenCalled();
  });

  it("stops at the scoped static catalog when it resolves the entry", async () => {
    scopedStaticMock.mockResolvedValue({
      entries: [{ provider: "acme", id: "static-model", reasoning: false }],
      routeVariants: [],
    });
    const { loadProviderScopedThinkingCatalog } = await import("./prepared-model-catalog.js");
    const catalog = await loadProviderScopedThinkingCatalog({
      config: {},
      provider: "acme",
      model: "static-model",
    });
    expect(catalog).toEqual([
      expect.objectContaining({ provider: "acme", id: "static-model", reasoning: false }),
    ]);
    expect(scopedStaticMock).toHaveBeenCalledTimes(1);
    expect(scopedStaticMock).toHaveBeenCalledWith(expect.anything(), ["acme"]);
    expect(scopedLiveMock).not.toHaveBeenCalled();
  });

  it("falls back to the scoped catalog while a published owner has the replaced config", async () => {
    preparedSnapshotMock.mockResolvedValue({
      agentDir: "/tmp/model-catalog-test",
      activeProjectKeys: [],
      config: { skills: { entries: { marker: { enabled: false } } } },
      authModes: {},
      metadataSnapshot: createPluginMetadataSnapshot({
        config: {},
        manifestRegistry: { plugins: [], diagnostics: [] },
      }),
      allowGatewaySubagentBinding: false,
      modelCatalog: { entries: [], routeVariants: [] },
      configuredRuntimeModels: [],
      inlineProviderModels: [],
      createStores: () => {
        throw new Error("stores are outside this catalog fallback test");
      },
    });
    scopedStaticMock.mockResolvedValue({
      entries: [{ provider: "acme", id: "replacement-model", reasoning: true }],
      routeVariants: [],
    });
    const { loadProviderScopedThinkingCatalog } = await import("./prepared-model-catalog.js");

    const catalog = await loadProviderScopedThinkingCatalog({
      config: { skills: { entries: { marker: { enabled: true } } } },
      provider: "acme",
      model: "replacement-model",
    });

    expect(catalog).toEqual([
      expect.objectContaining({ provider: "acme", id: "replacement-model", reasoning: true }),
    ]);
    expect(scopedStaticMock).toHaveBeenCalledWith(expect.anything(), ["acme"]);
  });

  it("runs provider-scoped live discovery for runtime-only models and keeps their thinking", async () => {
    scopedLiveMock.mockResolvedValue({ entries: [ollamaEntry], routeVariants: [] });
    const { loadProviderScopedThinkingCatalog } = await import("./prepared-model-catalog.js");
    const catalog = await loadProviderScopedThinkingCatalog({
      config: {},
      provider: "ollama",
      model: "minimax-m3:cloud",
    });
    expect(catalog).toEqual([expect.objectContaining(ollamaEntry)]);
    // Live discovery stays scoped to the requested provider: no broad plugin fanout.
    expect(scopedLiveMock).toHaveBeenCalledTimes(1);
    expect(scopedLiveMock).toHaveBeenCalledWith(expect.anything(), ["ollama"]);
    expect(scopedStaticMock).toHaveBeenCalledTimes(1);
  });
});
