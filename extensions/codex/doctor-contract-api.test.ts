// Codex tests cover doctor contract api plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { getSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  legacyConfigRules,
  normalizeCompatibilityConfig,
  stateMigrations,
} from "./doctor-contract-api.js";
import {
  bindingStoreKey,
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  CODEX_APP_SERVER_BINDING_NAMESPACE,
  createStoredCodexAppServerBinding,
  hashCodexAppServerBindingFingerprint,
  type StoredCodexAppServerBinding,
} from "./src/app-server/session-binding.js";
import { legacyCodexConversationBindingId } from "./src/conversation-binding-data.js";

function createDoctorContext(
  env: NodeJS.ProcessEnv,
  afterRegister?: () => Promise<void>,
): PluginDoctorStateMigrationContext {
  return {
    openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
      const store = createPluginStateKeyedStoreForTests<T>("codex", {
        ...options,
        env: options.env ?? env,
      });
      return afterRegister
        ? {
            ...store,
            async registerIfAbsent(...args: Parameters<typeof store.registerIfAbsent>) {
              const registered = await store.registerIfAbsent(...args);
              await afterRegister();
              return registered;
            },
          }
        : store;
    },
  };
}

type DoctorSessionEvidence = Awaited<
  ReturnType<NonNullable<PluginDoctorStateMigrationContext["readSessionIdentityEvidenceBatch"]>>
>[number];
type DoctorPluginStateRow = ReturnType<
  NonNullable<PluginDoctorStateMigrationContext["readPluginStateEntriesInKeyRange"]>
>[number];

function createOrphanedBindingMigrationFixture(
  options: {
    defaultEvidence?: "absent" | "unknown";
    replaceBeforeDelete?: (entry: DoctorPluginStateRow) => DoctorPluginStateRow;
  } = {},
) {
  const migration = stateMigrations.find(
    (candidate) => candidate.id === "codex-app-server-orphaned-session-bindings",
  );
  if (!migration) {
    throw new Error("missing Codex orphaned session binding migration");
  }
  const rows = new Map<string, DoctorPluginStateRow>();
  const evidence = new Map<string, DoctorSessionEvidence>();
  const pageReads: Array<{ prefix: string; after?: string; limit: number }> = [];
  const evidenceBatchSizes: number[] = [];
  const deletionBatchSizes: number[] = [];
  let sortedKeys: string[] | undefined;
  let nextCreatedAt = 1;
  let replaceBeforeDelete = options.replaceBeforeDelete;
  const env: NodeJS.ProcessEnv = {};

  function seedBinding(params: {
    agentId?: string;
    key?: string;
    sessionId: string;
    sessionKey?: string;
    value?: unknown;
    valueJson?: string;
  }): string {
    const agentId = params.agentId ?? "main";
    const key =
      params.key ??
      bindingStoreKey({
        kind: "session",
        agentId,
        sessionId: params.sessionId,
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      });
    const value = params.value ?? {
      version: 1,
      state: "active",
      sessionId: params.sessionId,
      binding: { threadId: `thread-${params.sessionId}`, cwd: "/workspace" },
    };
    const valueJson = params.valueJson ?? JSON.stringify(value);
    let parsedValue: unknown;
    try {
      parsedValue = JSON.parse(valueJson);
    } catch {
      // Physical corruption remains enumerable so healthy sibling rows can converge.
    }
    rows.set(key, {
      key,
      valueJson,
      ...(parsedValue !== undefined ? { value: parsedValue } : {}),
      createdAt: nextCreatedAt++,
      expiresAt: null,
    });
    sortedKeys = undefined;
    return key;
  }

  const context: PluginDoctorStateMigrationContext = {
    ...createDoctorContext(env),
    readPluginStateEntriesInKeyRange(storeOptions, range) {
      expect(storeOptions.namespace).toBe(CODEX_APP_SERVER_BINDING_NAMESPACE);
      expect(range.limit).toBeLessThanOrEqual(512);
      pageReads.push(range);
      sortedKeys ??= [...rows.keys()].toSorted();
      const start = range.after === undefined ? range.prefix : `${range.after}\0`;
      let lower = 0;
      let upper = sortedKeys.length;
      while (lower < upper) {
        const middle = Math.floor((lower + upper) / 2);
        if (sortedKeys[middle]! < start) {
          lower = middle + 1;
        } else {
          upper = middle;
        }
      }
      const page: DoctorPluginStateRow[] = [];
      for (let index = lower; index < sortedKeys.length; index += 1) {
        const key = sortedKeys[index]!;
        if (!key.startsWith(range.prefix)) {
          break;
        }
        const entry = rows.get(key);
        if (entry) {
          page.push(structuredClone(entry));
        }
        if (page.length === range.limit) {
          break;
        }
      }
      return page;
    },
    async readSessionIdentityEvidenceBatch(requests) {
      expect(requests.length).toBeLessThanOrEqual(512);
      evidenceBatchSizes.push(requests.length);
      return requests.map(
        (request) =>
          evidence.get(`${request.agentId}\0${request.sessionId}`) ?? {
            ...request,
            state: options.defaultEvidence ?? "absent",
          },
      );
    },
    deletePluginStateEntriesIfUnchanged(storeOptions, entries) {
      expect(storeOptions.namespace).toBe(CODEX_APP_SERVER_BINDING_NAMESPACE);
      expect(entries.length).toBeLessThanOrEqual(512);
      deletionBatchSizes.push(entries.length);
      const firstEntry = entries[0];
      if (replaceBeforeDelete && firstEntry) {
        rows.set(firstEntry.key, replaceBeforeDelete(firstEntry));
        replaceBeforeDelete = undefined;
      }
      let deleted = 0;
      for (const entry of entries) {
        const current = rows.get(entry.key);
        if (
          current &&
          current.createdAt === entry.createdAt &&
          current.expiresAt === entry.expiresAt &&
          current.valueJson === entry.valueJson
        ) {
          rows.delete(entry.key);
          deleted += 1;
        }
      }
      return { deleted, changed: entries.length - deleted };
    },
  };

  return {
    context,
    deletionBatchSizes,
    evidenceBatchSizes,
    migration,
    pageReads,
    params: { config: {}, env, stateDir: "/unused", oauthDir: "/unused/oauth", context },
    rows,
    seedBinding,
    setEvidence(value: DoctorSessionEvidence) {
      evidence.set(`${value.agentId}\0${value.sessionId}`, value);
    },
  };
}

function openBindingStore(env: NodeJS.ProcessEnv) {
  return createDoctorContext(env).openPluginStateKeyedStore<StoredCodexAppServerBinding>({
    namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
    maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
}

async function removeCodexDoctorFixture(stateDir: string): Promise<void> {
  // Doctor migrations open per-agent databases and leave the shared state database open under
  // the temporary state dir; both must be released before removal or Windows keeps the files
  // locked and the removal fails with EBUSY. Agent close first: it releases leases through
  // shared state, so the reverse order can reopen it.
  closeOpenClawAgentDatabasesForTest();
  resetPluginStateStoreForTests();
  await fs.rm(stateDir, { recursive: true, force: true });
}

async function createBindingMigrationFixture(options: {
  binding?: Record<string, unknown>;
  legacySharedRoot?: boolean;
  name: string;
  sessionIndex?: Record<string, unknown>;
  storeRoot?: "agent" | "fixed";
  threadId: string;
}) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-doctor-"));
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const sessionsDir =
    options.storeRoot === "fixed"
      ? path.join(stateDir, "fixed-sessions")
      : options.legacySharedRoot
        ? path.join(stateDir, "sessions")
        : path.join(stateDir, "agents", "main", "sessions");
  const storePath = path.join(sessionsDir, "sessions.json");
  const transcriptPath = path.join(sessionsDir, `${options.name}.jsonl`);
  const sidecarPath = `${transcriptPath}.codex-app-server.json`;
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.writeFile(
    transcriptPath,
    `${JSON.stringify({ type: "session", id: options.name })}\n`,
    "utf8",
  );
  if (options.sessionIndex !== undefined) {
    await fs.writeFile(storePath, JSON.stringify(options.sessionIndex), "utf8");
  }
  await fs.writeFile(
    sidecarPath,
    JSON.stringify({
      schemaVersion: 2,
      threadId: options.threadId,
      sessionFile: transcriptPath,
      updatedAt: "2026-01-01T00:00:00.000Z",
      pluginAppPolicyContext: {
        fingerprint: "policy-1",
        apps: {},
        pluginAppIds: {},
      },
      ...options.binding,
    }),
    "utf8",
  );
  const migration = stateMigrations[0];
  if (!migration) {
    throw new Error("missing Codex binding migration");
  }
  return {
    env,
    migration,
    params: {
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: createDoctorContext(env),
    },
    sessionsDir,
    sidecarPath,
    stateDir,
    storePath,
    transcriptPath,
  };
}

afterEach(() => {
  resetPluginStateStoreForTests();
});

describe("codex doctor contract", () => {
  it("reports the retired dynamic tools profile config key", () => {
    expect(
      legacyConfigRules[0]?.match({
        codexDynamicToolsProfile: "openclaw-compat",
        codexDynamicToolsLoading: "direct",
      }),
    ).toBe(true);
    expect(legacyConfigRules[0]?.match({ codexDynamicToolsLoading: "direct" })).toBe(false);
  });

  it("reports old approval-routed destructive plugin policy values", () => {
    expect(
      legacyConfigRules[1]?.match({
        allow_destructive_actions: "on-request",
        plugins: {},
      }),
    ).toBe(true);
    expect(
      legacyConfigRules[1]?.match({
        allow_destructive_actions: true,
        plugins: {
          "google-calendar": { allow_destructive_actions: "on-request" },
        },
      }),
    ).toBe(true);
    expect(
      legacyConfigRules[1]?.match({
        allow_destructive_actions: "auto",
        plugins: {
          "google-calendar": { allow_destructive_actions: true },
        },
      }),
    ).toBe(false);
    expect(
      legacyConfigRules[1]?.match({
        allow_destructive_actions: "ask",
        plugins: {
          "google-calendar": { allow_destructive_actions: "ask" },
        },
      }),
    ).toBe(false);
    expect(
      legacyConfigRules[1]?.match({
        allow_destructive_actions: "always",
        plugins: {
          "google-calendar": { allow_destructive_actions: "always" },
        },
      }),
    ).toBe(false);
  });

  it("reports the retired on-failure app-server approval policy", () => {
    expect(legacyConfigRules[2]?.match({ approvalPolicy: "on-failure" })).toBe(true);
    expect(legacyConfigRules[2]?.match({ approvalPolicy: "on-request" })).toBe(false);
  });

  it("removes the retired dynamic tools profile without dropping other Codex config", () => {
    const original = {
      plugins: {
        entries: {
          codex: {
            enabled: true,
            config: {
              codexDynamicToolsProfile: "openclaw-compat",
              codexDynamicToolsLoading: "direct",
              codexDynamicToolsExclude: ["custom_tool"],
              appServer: { mode: "guardian" },
            },
          },
        },
      },
    };

    const result = normalizeCompatibilityConfig({ cfg: original });

    expect(result.changes).toEqual([
      "Removed retired plugins.entries.codex.config.codexDynamicToolsProfile; Codex app-server always keeps Codex-native workspace tools native.",
    ]);
    expect(result.config.plugins?.entries?.codex?.config).toEqual({
      codexDynamicToolsLoading: "direct",
      codexDynamicToolsExclude: ["custom_tool"],
      appServer: { mode: "guardian" },
    });
    expect(original.plugins.entries.codex.config).toHaveProperty("codexDynamicToolsProfile");
  });

  it("preserves the fixed-store owner when it differs from the system owner", async () => {
    const sessionKey = "legacy-fixed-store";
    const fixture = await createBindingMigrationFixture({
      name: "fixed-store-owner",
      sessionIndex: {
        [sessionKey]: {
          sessionId: "fixed-store-owner",
          sessionFile: "fixed-store-owner.jsonl",
          updatedAt: 1,
        },
      },
      storeRoot: "fixed",
      threadId: "thread-fixed-store-owner",
    });
    const params = {
      ...fixture.params,
      config: {
        session: { store: fixture.storePath },
        agents: {
          ownership: "explicit" as const,
          defaults: {
            systemAgent: { agentId: "main" },
            sessionStore: { agentId: "ops" },
          },
          entries: { main: {}, ops: {} },
        },
      },
    };

    try {
      await expect(fixture.migration.migrateLegacyState(params)).resolves.toMatchObject({
        changes: [expect.stringContaining("Migrated 1")],
        warnings: [],
      });
      await expect(
        openBindingStore(fixture.env).lookup(
          bindingStoreKey({
            kind: "session",
            agentId: "ops",
            sessionId: "fixed-store-owner",
            sessionKey,
          }),
        ),
      ).resolves.toMatchObject({
        state: "active",
        sessionId: "fixed-store-owner",
      });
      expect(
        getSessionEntry({
          agentId: "ops",
          env: fixture.env,
          sessionKey,
          storePath: fixture.storePath,
        }),
      ).toMatchObject({ agentHarnessId: "codex" });
    } finally {
      await removeCodexDoctorFixture(fixture.stateDir);
    }
  });

  it("imports and archives shipped binding sidecars", async () => {
    const fixture = await createBindingMigrationFixture({
      name: "session-current",
      sessionIndex: {
        "agent:main:session-1": {
          sessionId: "session-current",
          sessionFile: "session-current.jsonl",
          updatedAt: 1,
        },
      },
      threadId: "thread-1",
      binding: {
        pluginAppPolicyContext: {
          fingerprint: "policy-1",
          apps: {
            app: {
              configKey: "app",
              marketplaceName: "openai-curated",
              pluginName: "plugin",
              allowDestructiveActions: true,
              destructiveApprovalMode: "ask",
              mcpServerNames: [],
            },
          },
          pluginAppIds: {},
        },
      },
    });

    await expect(fixture.migration.detectLegacyState(fixture.params)).resolves.toMatchObject({
      preview: [expect.stringContaining("legacy sidecar")],
    });
    await expect(fixture.migration.migrateLegacyState(fixture.params)).resolves.toMatchObject({
      changes: [expect.stringContaining("Migrated 1")],
      warnings: [],
    });

    const store = openBindingStore(fixture.env);
    await expect(
      store.lookup(
        bindingStoreKey({
          kind: "session",
          agentId: "main",
          sessionId: "session-current",
          sessionKey: "agent:main:session-1",
        }),
      ),
    ).resolves.toMatchObject({
      state: "active",
      sessionId: "session-current",
      binding: {
        threadId: "thread-1",
        pluginAppPolicyContext: {
          apps: { app: { destructiveApprovalMode: "ask" } },
        },
      },
    });
    await expect(
      store.lookup(
        bindingStoreKey({
          kind: "conversation",
          bindingId: legacyCodexConversationBindingId(fixture.transcriptPath),
        }),
      ),
    ).resolves.toMatchObject({ state: "active", binding: { threadId: "thread-1" } });
    await expect(fs.access(`${fixture.sidecarPath}.migrated`)).resolves.toBeUndefined();
    expect(
      getSessionEntry({
        agentId: "main",
        env: fixture.env,
        sessionKey: "agent:main:session-1",
        storePath: fixture.storePath,
      }),
    ).toMatchObject({
      sessionId: "session-current",
      agentHarnessId: "codex",
    });
    await expect(
      fs.readFile(fixture.storePath, "utf8").then(JSON.parse),
    ).resolves.not.toHaveProperty("agent:main:session-1.agentHarnessId");

    await removeCodexDoctorFixture(fixture.stateDir);
  });

  it.each([
    ["without a system agent", undefined],
    ["with a missing system agent", { systemAgent: { agentId: "missing" } }],
  ] as const)("preserves ambiguous shared-root bindings %s", async (_label, defaults) => {
    const fixture = await createBindingMigrationFixture({
      legacySharedRoot: true,
      name: "explicit-owner",
      sessionIndex: {
        legacy: {
          sessionId: "explicit-owner",
          sessionFile: "explicit-owner.jsonl",
          updatedAt: 1,
        },
      },
      threadId: "thread-explicit-owner",
    });
    const params = {
      ...fixture.params,
      config: {
        agents: { ownership: "explicit" as const, defaults, entries: { main: {}, ops: {} } },
      },
    };

    await expect(fixture.migration.detectLegacyState(params)).resolves.toMatchObject({
      preview: [expect.stringContaining("legacy sidecar")],
    });
    const result = await fixture.migration.migrateLegacyState(params);

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining("session ownership is indeterminate"),
    ]);
    await expect(fs.access(fixture.sidecarPath)).resolves.toBeUndefined();
    await expect(fs.access(`${fixture.sidecarPath}.migrated`)).rejects.toThrow();
    await expect(openBindingStore(fixture.env).entries()).resolves.toEqual([]);

    await removeCodexDoctorFixture(fixture.stateDir);
  });

  it("migrates a shared-root binding to the configured system agent", async () => {
    const sessionKey = "legacy";
    const fixture = await createBindingMigrationFixture({
      legacySharedRoot: true,
      name: "system-agent-owner",
      sessionIndex: {
        [sessionKey]: {
          sessionId: "system-agent-owner",
          sessionFile: "system-agent-owner.jsonl",
          updatedAt: 1,
        },
      },
      threadId: "thread-system-agent-owner",
    });
    const params = {
      ...fixture.params,
      config: {
        agents: {
          ownership: "explicit" as const,
          defaults: { systemAgent: { agentId: "main" } },
          entries: { main: {}, blocker: {}, digest: {} },
        },
      },
    };

    await expect(fixture.migration.migrateLegacyState(params)).resolves.toMatchObject({
      changes: [expect.stringContaining("Migrated 1")],
      warnings: [],
    });
    await expect(
      openBindingStore(fixture.env).lookup(
        bindingStoreKey({
          kind: "session",
          agentId: "main",
          sessionId: "system-agent-owner",
          sessionKey,
        }),
      ),
    ).resolves.toMatchObject({ sessionId: "system-agent-owner" });
    expect(
      getSessionEntry({
        agentId: "main",
        env: fixture.env,
        sessionKey,
        storePath: fixture.storePath,
      }),
    ).toMatchObject({ agentHarnessId: "codex" });
    await expect(fs.access(`${fixture.sidecarPath}.migrated`)).resolves.toBeUndefined();

    await removeCodexDoctorFixture(fixture.stateDir);
  });

  it("keeps an agent-scoped shared-root binding with its explicit owner", async () => {
    const sessionKey = "agent:ops:legacy";
    const fixture = await createBindingMigrationFixture({
      legacySharedRoot: true,
      name: "explicit-ops-owner",
      sessionIndex: {
        [sessionKey]: {
          sessionId: "explicit-ops-owner",
          sessionFile: "explicit-ops-owner.jsonl",
          updatedAt: 1,
        },
      },
      threadId: "thread-explicit-ops-owner",
    });
    const params = {
      ...fixture.params,
      config: {
        agents: {
          ownership: "explicit" as const,
          defaults: { systemAgent: { agentId: "main" } },
          entries: { main: {}, ops: {} },
        },
      },
    };

    await expect(fixture.migration.migrateLegacyState(params)).resolves.toMatchObject({
      changes: [expect.stringContaining("Migrated 1")],
      warnings: [],
    });
    await expect(
      openBindingStore(fixture.env).lookup(
        bindingStoreKey({
          kind: "session",
          agentId: "ops",
          sessionId: "explicit-ops-owner",
          sessionKey,
        }),
      ),
    ).resolves.toMatchObject({ sessionId: "explicit-ops-owner" });
    await expect(fs.access(`${fixture.sidecarPath}.migrated`)).resolves.toBeUndefined();

    await removeCodexDoctorFixture(fixture.stateDir);
  });

  it("bounds oversized legacy fingerprints before plugin-state import", async () => {
    const rawDynamicToolsFingerprint = JSON.stringify([
      { name: "legacy_large_tool", inputSchema: { description: "dynamic-marker".repeat(8_000) } },
    ]);
    const rawUserMcpServersFingerprint = JSON.stringify({
      mcp_servers: {
        legacy: {
          command: "node",
          args: ["user-mcp-marker".repeat(8_000)],
          http_headers: { authorization: "Bearer legacy-secret" },
        },
      },
    });
    const sessionKey = "agent:main:oversized";
    const fixture = await createBindingMigrationFixture({
      name: "oversized",
      sessionIndex: {
        [sessionKey]: {
          sessionId: "oversized",
          sessionFile: "oversized.jsonl",
        },
      },
      threadId: "thread-oversized",
      binding: {
        dynamicToolsFingerprint: rawDynamicToolsFingerprint,
        userMcpServersFingerprint: rawUserMcpServersFingerprint,
      },
    });
    expect((await fs.stat(fixture.sidecarPath)).size).toBeGreaterThan(65_536);

    await expect(fixture.migration.migrateLegacyState(fixture.params)).resolves.toEqual({
      changes: [
        "Migrated 1 Codex app-server binding sidecar(s) to plugin state and archived the legacy sources",
      ],
      warnings: [],
    });

    const stored = await openBindingStore(fixture.env).lookup(
      bindingStoreKey({
        kind: "session",
        agentId: "main",
        sessionId: "oversized",
        sessionKey,
      }),
    );
    expect(stored).toMatchObject({
      state: "active",
      binding: {
        dynamicToolsFingerprint: hashCodexAppServerBindingFingerprint(rawDynamicToolsFingerprint),
        userMcpServersFingerprint: hashCodexAppServerBindingFingerprint(
          rawUserMcpServersFingerprint,
        ),
      },
    });
    expect(Buffer.byteLength(JSON.stringify(stored))).toBeLessThan(65_536);
    expect(JSON.stringify(stored)).not.toContain("dynamic-marker");
    expect(JSON.stringify(stored)).not.toContain("user-mcp-marker");
    expect(JSON.stringify(stored)).not.toContain("legacy-secret");
    await expect(fs.access(fixture.sidecarPath)).rejects.toThrow();
    await expect(fs.access(`${fixture.sidecarPath}.migrated`)).resolves.toBeUndefined();
    await expect(fixture.migration.migrateLegacyState(fixture.params)).resolves.toEqual({
      changes: [],
      warnings: [],
    });

    await removeCodexDoctorFixture(fixture.stateDir);
  });

  it("normalizes a partial raw conversation import before copying the session row", async () => {
    const threadId = "thread-partial-import";
    const sessionId = "partial-import";
    const sessionKey = "agent:main:partial-import";
    const emptyConversation: StoredCodexAppServerBinding = {
      version: 1,
      state: "active",
      binding: {
        threadId,
        cwd: "",
        dynamicToolsFingerprint: "",
      },
    };
    const rawFingerprint = "x".repeat(
      65_535 - Buffer.byteLength(JSON.stringify(emptyConversation)),
    );
    const rawConversation: StoredCodexAppServerBinding = {
      ...emptyConversation,
      binding: {
        ...emptyConversation.binding,
        dynamicToolsFingerprint: rawFingerprint,
      },
    };
    const rawSession = { ...rawConversation, sessionId };
    expect(Buffer.byteLength(JSON.stringify(rawConversation))).toBe(65_535);
    expect(Buffer.byteLength(JSON.stringify(rawSession))).toBeGreaterThan(65_536);

    const fixture = await createBindingMigrationFixture({
      name: sessionId,
      sessionIndex: {
        [sessionKey]: {
          sessionId,
          sessionFile: `${sessionId}.jsonl`,
        },
      },
      threadId,
      binding: { dynamicToolsFingerprint: rawFingerprint },
    });
    const conversationKey = bindingStoreKey({
      kind: "conversation",
      bindingId: legacyCodexConversationBindingId(fixture.transcriptPath),
    });
    const sessionBindingKey = bindingStoreKey({
      kind: "session",
      agentId: "main",
      sessionId,
      sessionKey,
    });
    const store = openBindingStore(fixture.env);
    await store.register(conversationKey, rawConversation);

    await expect(fixture.migration.migrateLegacyState(fixture.params)).resolves.toEqual({
      changes: [
        "Migrated 1 Codex app-server binding sidecar(s) to plugin state and archived the legacy sources",
      ],
      warnings: [],
    });

    const expectedFingerprint = hashCodexAppServerBindingFingerprint(rawFingerprint);
    await expect(store.lookup(conversationKey)).resolves.toMatchObject({
      state: "active",
      binding: { dynamicToolsFingerprint: expectedFingerprint },
    });
    await expect(store.lookup(sessionBindingKey)).resolves.toMatchObject({
      state: "active",
      sessionId,
      binding: { dynamicToolsFingerprint: expectedFingerprint },
    });
    await expect(fs.access(fixture.sidecarPath)).rejects.toThrow();
    await expect(fs.access(`${fixture.sidecarPath}.migrated`)).resolves.toBeUndefined();
    await expect(fixture.migration.migrateLegacyState(fixture.params)).resolves.toEqual({
      changes: [],
      warnings: [],
    });

    await removeCodexDoctorFixture(fixture.stateDir);
  });

  it("normalizes retained raw conversation and session rows before comparison", async () => {
    const threadId = "thread-retained-import";
    const sessionId = "retained-import";
    const sessionKey = "agent:main:retained-import";
    const rawFingerprint = "x".repeat(60_000);
    const rawConversation: StoredCodexAppServerBinding = {
      version: 1,
      state: "active",
      binding: {
        threadId,
        cwd: "",
        dynamicToolsFingerprint: rawFingerprint,
      },
    };
    const rawSession: StoredCodexAppServerBinding = {
      ...rawConversation,
      sessionId,
    };
    expect(Buffer.byteLength(JSON.stringify(rawSession))).toBeLessThan(65_536);

    const fixture = await createBindingMigrationFixture({
      name: sessionId,
      sessionIndex: {
        [sessionKey]: {
          sessionId,
          sessionFile: `${sessionId}.jsonl`,
        },
      },
      threadId,
      binding: { dynamicToolsFingerprint: rawFingerprint },
    });
    const conversationKey = bindingStoreKey({
      kind: "conversation",
      bindingId: legacyCodexConversationBindingId(fixture.transcriptPath),
    });
    const sessionBindingKey = bindingStoreKey({
      kind: "session",
      agentId: "main",
      sessionId,
      sessionKey,
    });
    const store = openBindingStore(fixture.env);
    await store.register(conversationKey, rawConversation);
    await store.register(sessionBindingKey, rawSession);

    await expect(fixture.migration.migrateLegacyState(fixture.params)).resolves.toEqual({
      changes: [
        "Migrated 1 Codex app-server binding sidecar(s) to plugin state and archived the legacy sources",
      ],
      warnings: [],
    });

    const expectedFingerprint = hashCodexAppServerBindingFingerprint(rawFingerprint);
    await expect(store.lookup(conversationKey)).resolves.toMatchObject({
      state: "active",
      binding: { dynamicToolsFingerprint: expectedFingerprint },
    });
    await expect(store.lookup(sessionBindingKey)).resolves.toMatchObject({
      state: "active",
      sessionId,
      binding: { dynamicToolsFingerprint: expectedFingerprint },
    });
    await expect(fs.access(fixture.sidecarPath)).rejects.toThrow();
    await expect(fs.access(`${fixture.sidecarPath}.migrated`)).resolves.toBeUndefined();
    await expect(fixture.migration.migrateLegacyState(fixture.params)).resolves.toEqual({
      changes: [],
      warnings: [],
    });

    await removeCodexDoctorFixture(fixture.stateDir);
  });

  it("rejects an explicit session file locator outside the session directory", async () => {
    const sessionKey = "agent:main:stale-locator";
    const fixture = await createBindingMigrationFixture({
      name: "stale-locator",
      sessionIndex: {
        [sessionKey]: {
          sessionId: "stale-locator",
          sessionFile: "../outside.jsonl",
        },
      },
      threadId: "thread-stale-locator",
    });

    const result = await fixture.migration.migrateLegacyState(fixture.params);

    expect(result.changes).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("invalid locator");
    await expect(fs.access(fixture.sidecarPath)).resolves.toBeUndefined();
    await expect(fs.access(`${fixture.sidecarPath}.migrated`)).rejects.toThrow();
    expect(
      getSessionEntry({
        agentId: "main",
        env: fixture.env,
        sessionKey,
        storePath: fixture.storePath,
      }),
    ).toBeUndefined();
    await expect(openBindingStore(fixture.env).entries()).resolves.toEqual([]);

    await removeCodexDoctorFixture(fixture.stateDir);
  });

  it("deduplicates session-store aliases before classifying binding ownership", async () => {
    const fixture = await createBindingMigrationFixture({
      name: "aliased-store",
      sessionIndex: {
        "agent:main:aliased-store": {
          sessionId: "aliased-store",
          sessionFile: "aliased-store.jsonl",
        },
      },
      threadId: "thread-aliased-store",
    });
    await fs.writeFile(
      path.join(fixture.sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:aliased-store": {
          sessionId: "aliased-store",
          sessionFile: fixture.transcriptPath,
        },
      }),
      "utf8",
    );
    const storeAlias = path.join(fixture.stateDir, "sessions-alias.json");
    await fs.symlink(path.join(fixture.sessionsDir, "sessions.json"), storeAlias);

    const result = await fixture.migration.migrateLegacyState({
      ...fixture.params,
      config: { session: { store: storeAlias } },
    });

    expect(result.warnings).toEqual([]);
    await expect(fs.access(`${fixture.sidecarPath}.migrated`)).resolves.toBeUndefined();
    const configuredIndex = JSON.parse(await fs.readFile(storeAlias, "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    const targetIndex = JSON.parse(
      await fs.readFile(path.join(fixture.sessionsDir, "sessions.json"), "utf8"),
    ) as Record<string, Record<string, unknown>>;
    expect(
      getSessionEntry({
        agentId: "main",
        env: fixture.env,
        sessionKey: "agent:main:aliased-store",
        storePath: storeAlias,
      }),
    ).toMatchObject({ agentHarnessId: "codex" });
    expect(configuredIndex["agent:main:aliased-store"]).not.toHaveProperty("agentHarnessId");
    expect(targetIndex["agent:main:aliased-store"]).not.toHaveProperty("agentHarnessId");

    await removeCodexDoctorFixture(fixture.stateDir);
  });

  it("resolves relative session files from a symlinked store path", async () => {
    const sessionKey = "agent:main:symlinked-store";
    const fixture = await createBindingMigrationFixture({
      name: "symlinked-store",
      sessionIndex: {
        [sessionKey]: {
          sessionId: "symlinked-store",
          sessionFile: "symlinked-store.jsonl",
        },
      },
      threadId: "thread-symlinked-store",
    });
    const configuredDir = path.join(fixture.stateDir, "configured-sessions");
    const configuredStore = path.join(configuredDir, "sessions.json");
    const configuredTranscript = path.join(configuredDir, "symlinked-store.jsonl");
    const configuredSidecar = `${configuredTranscript}.codex-app-server.json`;
    await fs.mkdir(configuredDir, { recursive: true });
    await fs.rename(fixture.transcriptPath, configuredTranscript);
    await fs.rename(fixture.sidecarPath, configuredSidecar);
    const sidecar = JSON.parse(await fs.readFile(configuredSidecar, "utf8")) as Record<
      string,
      unknown
    >;
    await fs.writeFile(
      configuredSidecar,
      JSON.stringify({ ...sidecar, sessionFile: configuredTranscript }),
      "utf8",
    );
    await fs.symlink(path.join(fixture.sessionsDir, "sessions.json"), configuredStore);

    const result = await fixture.migration.migrateLegacyState({
      ...fixture.params,
      config: { session: { store: configuredStore } },
    });

    expect(result.warnings).toEqual([]);
    await expect(fs.access(`${configuredSidecar}.migrated`)).resolves.toBeUndefined();
    expect(
      getSessionEntry({
        agentId: "main",
        env: fixture.env,
        sessionKey,
        storePath: configuredStore,
      }),
    ).toMatchObject({ agentHarnessId: "codex" });
    await expect(fs.readFile(configuredStore, "utf8").then(JSON.parse)).resolves.not.toHaveProperty(
      `${sessionKey}.agentHarnessId`,
    );

    await removeCodexDoctorFixture(fixture.stateDir);
  });

  it.each([
    { label: "new", preexisting: false },
    { label: "pre-existing", preexisting: true },
  ])(
    "retires a $label session row when its owner rebinds during migration",
    async ({ preexisting }) => {
      const sessionKey = "agent:main:session-1";
      const fixture = await createBindingMigrationFixture({
        name: "session-current",
        sessionIndex: {
          [sessionKey]: {
            sessionId: "session-current",
            sessionFile: "session-current.jsonl",
            lifecycleRevision: "rev-1",
          },
        },
        threadId: "thread-1",
      });
      const sessionBindingKey = bindingStoreKey({
        kind: "session",
        agentId: "main",
        sessionId: "session-current",
        sessionKey,
      });
      const imported = createStoredCodexAppServerBinding(
        JSON.parse(await fs.readFile(fixture.sidecarPath, "utf8")),
      );
      if (!imported) {
        throw new Error("missing imported Codex binding");
      }
      const store = openBindingStore(fixture.env);
      if (preexisting) {
        await store.register(sessionBindingKey, { ...imported, sessionId: "session-current" });
      }
      let rebound = false;
      const context = createDoctorContext(fixture.env, async () => {
        if (rebound) {
          return;
        }
        rebound = true;
        await upsertSessionEntry({
          agentId: "main",
          env: fixture.env,
          sessionKey,
          storePath: fixture.storePath,
          entry: {
            sessionId: "session-current",
            lifecycleRevision: "rev-2",
            updatedAt: Date.now(),
          },
        });
      });

      const result = await fixture.migration.migrateLegacyState({ ...fixture.params, context });

      expect(result.warnings).toEqual([]);
      expect(result.notices).toEqual([
        expect.stringContaining("session owner changed before Codex ownership could be recorded"),
      ]);
      await expect(fs.access(fixture.sidecarPath)).resolves.toBeUndefined();
      await expect(fs.access(`${fixture.sidecarPath}.migrated`)).rejects.toThrow();
      await expect(
        fs.readFile(path.join(fixture.sessionsDir, "sessions.json"), "utf8").then(JSON.parse),
      ).resolves.not.toHaveProperty(`${sessionKey}.agentHarnessId`);
      expect(
        getSessionEntry({
          agentId: "main",
          env: fixture.env,
          sessionKey,
          storePath: fixture.storePath,
        }),
      ).toMatchObject({ lifecycleRevision: "rev-2" });
      await expect(store.lookup(sessionBindingKey)).resolves.toMatchObject({
        version: 1,
        state: "cleared",
        sessionId: "session-current",
        retired: true,
      });

      await removeCodexDoctorFixture(fixture.stateDir);
    },
  );

  it("retires an imported row when its locator escapes during owner revalidation", async () => {
    const sessionKey = "agent:main:locator-race";
    const fixture = await createBindingMigrationFixture({
      name: "locator-race",
      sessionIndex: {
        [sessionKey]: {
          sessionId: "locator-race",
          sessionFile: "locator-race.jsonl",
        },
      },
      threadId: "thread-locator-race",
    });
    let rebound = false;
    const context = createDoctorContext(fixture.env, async () => {
      if (rebound) {
        return;
      }
      rebound = true;
      await fs.writeFile(
        fixture.storePath,
        JSON.stringify({
          [sessionKey]: {
            sessionId: "locator-race",
            sessionFile: "../outside.jsonl",
          },
        }),
      );
    });

    const result = await fixture.migration.migrateLegacyState({ ...fixture.params, context });

    expect(result.warnings).toEqual([]);
    expect(result.notices).toEqual([
      expect.stringContaining("session owner changed before Codex ownership could be recorded"),
    ]);
    await expect(fs.access(fixture.sidecarPath)).resolves.toBeUndefined();
    await expect(fs.access(`${fixture.sidecarPath}.migrated`)).rejects.toThrow();
    await expect(
      openBindingStore(fixture.env).lookup(
        bindingStoreKey({
          kind: "session",
          agentId: "main",
          sessionId: "locator-race",
          sessionKey,
        }),
      ),
    ).resolves.toMatchObject({
      version: 1,
      state: "cleared",
      sessionId: "locator-race",
      retired: true,
    });

    await removeCodexDoctorFixture(fixture.stateDir);
  });

  it("does not resurrect a retired session generation from its legacy sidecar", async () => {
    const sessionKey = "agent:main:retired";
    const fixture = await createBindingMigrationFixture({
      name: "retired",
      sessionIndex: {
        [sessionKey]: {
          sessionId: "retired",
          sessionFile: "retired.jsonl",
        },
      },
      threadId: "thread-retired",
    });
    const store = openBindingStore(fixture.env);
    const active = createStoredCodexAppServerBinding(
      JSON.parse(await fs.readFile(fixture.sidecarPath, "utf8")),
    );
    if (!active) {
      throw new Error("missing imported Codex binding");
    }
    await store.register(
      bindingStoreKey({
        kind: "conversation",
        bindingId: legacyCodexConversationBindingId(fixture.transcriptPath),
      }),
      active,
    );
    const sessionBindingKey = bindingStoreKey({
      kind: "session",
      agentId: "main",
      sessionId: "retired",
      sessionKey,
    });
    const retired: StoredCodexAppServerBinding = {
      version: 1,
      state: "cleared",
      sessionId: "retired",
      retired: true,
    };
    await store.register(sessionBindingKey, retired);

    const result = await fixture.migration.migrateLegacyState(fixture.params);

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining(`canonical plugin state changed at ${sessionBindingKey}`),
    ]);
    await expect(fs.access(fixture.sidecarPath)).resolves.toBeUndefined();
    await expect(store.lookup(sessionBindingKey)).resolves.toEqual(retired);
    await expect(
      fs.readFile(path.join(fixture.sessionsDir, "sessions.json"), "utf8").then(JSON.parse),
    ).resolves.not.toHaveProperty(`${sessionKey}.agentHarnessId`);

    await removeCodexDoctorFixture(fixture.stateDir);
  });

  it.each(["active", "cleared"] as const)(
    "archives zero-owner sidecars without changing imported $state conversation state",
    async (state) => {
      const fixture = await createBindingMigrationFixture({
        name: `orphan-${state}`,
        threadId: "thread-orphan",
      });
      const bindingKey = bindingStoreKey({
        kind: "conversation",
        bindingId: legacyCodexConversationBindingId(fixture.transcriptPath),
      });
      const active = createStoredCodexAppServerBinding(
        JSON.parse(await fs.readFile(fixture.sidecarPath, "utf8")),
      );
      if (!active) {
        throw new Error("missing imported Codex binding");
      }
      const existing: StoredCodexAppServerBinding =
        state === "active" ? active : { version: 1, state: "cleared", retired: true };
      const store = openBindingStore(fixture.env);
      await store.register(bindingKey, existing);

      await expect(fixture.migration.migrateLegacyState(fixture.params)).resolves.toEqual({
        changes: [
          "Migrated 1 Codex app-server binding sidecar(s) to plugin state and archived the legacy sources",
        ],
        warnings: [],
      });
      await expect(fs.access(fixture.sidecarPath)).rejects.toThrow();
      await expect(fs.access(`${fixture.sidecarPath}.migrated`)).resolves.toBeUndefined();
      await expect(store.lookup(bindingKey)).resolves.toEqual(existing);
      await expect(fixture.migration.detectLegacyState(fixture.params)).resolves.toBeNull();
      await expect(fixture.migration.migrateLegacyState(fixture.params)).resolves.toEqual({
        changes: [],
        warnings: [],
      });

      await removeCodexDoctorFixture(fixture.stateDir);
    },
  );

  it("ignores metadata-only session rows when proving zero ownership", async () => {
    const fixture = await createBindingMigrationFixture({
      name: "orphan-metadata-row",
      sessionIndex: {
        "agent:main:metadata-only": {
          label: "Waiting for first turn",
          updatedAt: 1,
        },
      },
      threadId: "thread-orphan",
    });

    await expect(fixture.migration.migrateLegacyState(fixture.params)).resolves.toEqual({
      changes: [
        "Migrated 1 Codex app-server binding sidecar(s) to plugin state and archived the legacy sources",
      ],
      warnings: [],
    });
    await expect(fs.access(fixture.sidecarPath)).rejects.toThrow();
    await expect(fs.access(`${fixture.sidecarPath}.migrated`)).resolves.toBeUndefined();

    await removeCodexDoctorFixture(fixture.stateDir);
  });

  it("retains a zero-owner sidecar when canonical plugin state is malformed", async () => {
    const fixture = await createBindingMigrationFixture({
      name: "orphan-invalid-state",
      threadId: "thread-orphan",
    });
    const bindingKey = bindingStoreKey({
      kind: "conversation",
      bindingId: legacyCodexConversationBindingId(fixture.transcriptPath),
    });
    const store = createDoctorContext(fixture.env).openPluginStateKeyedStore<unknown>({
      namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
      maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    const malformed = { version: 1, state: "active" };
    await store.register(bindingKey, malformed);

    const result = await fixture.migration.migrateLegacyState(fixture.params);

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining(`canonical plugin state is invalid at ${bindingKey}`),
    ]);
    await expect(fs.access(fixture.sidecarPath)).resolves.toBeUndefined();
    await expect(store.lookup(bindingKey)).resolves.toEqual(malformed);

    await removeCodexDoctorFixture(fixture.stateDir);
  });

  it("retains mixed Codex and foreign ambiguous binding owners", async () => {
    const fixture = await createBindingMigrationFixture({
      name: "shared",
      sessionIndex: {
        "agent:main:first": {
          sessionId: "first",
          sessionFile: "shared.jsonl",
          agentHarnessId: "codex",
        },
        "agent:main:second": {
          sessionId: "second",
          sessionFile: "shared.jsonl",
          agentHarnessId: "pi",
        },
      },
      threadId: "thread-shared",
    });

    const result = await fixture.migration.migrateLegacyState(fixture.params);

    expect(result.changes).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("2 matching session owners make ownership ambiguous");
    await expect(fs.access(fixture.sidecarPath)).resolves.toBeUndefined();
    await expect(openBindingStore(fixture.env).entries()).resolves.toEqual([]);

    await removeCodexDoctorFixture(fixture.stateDir);
  });

  it("retains a sidecar owned by a foreign harness without importing plugin state", async () => {
    const fixture = await createBindingMigrationFixture({
      name: "foreign",
      sessionIndex: {
        "agent:main:foreign": {
          sessionId: "foreign",
          sessionFile: "foreign.jsonl",
          agentHarnessId: "pi",
        },
      },
      threadId: "thread-foreign",
    });

    const result = await fixture.migration.migrateLegacyState(fixture.params);

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.notices).toEqual([expect.stringContaining("owned by agent harness pi")]);
    await expect(fs.access(fixture.sidecarPath)).resolves.toBeUndefined();
    await expect(openBindingStore(fixture.env).entries()).resolves.toEqual([]);

    await removeCodexDoctorFixture(fixture.stateDir);
  });

  it.each([
    { contents: "{", detail: "invalid JSON", label: "invalid JSON" },
    {
      contents: JSON.stringify({
        "agent:main:invalid": { sessionId: "invalid", agentHarnessId: 42 },
      }),
      detail: "invalid entries",
      label: "malformed harness metadata",
    },
    {
      contents: JSON.stringify({
        "agent:main:unsafe": { sessionId: "../unsafe", sessionFile: "unsafe.jsonl" },
      }),
      detail: "invalid entries",
      label: "unsafe session id",
    },
  ])("retains binding sidecars for an indeterminate $label index", async ({ contents, detail }) => {
    const fixture = await createBindingMigrationFixture({
      name: "unknown-owner",
      threadId: "thread-unknown-owner",
    });
    const externalDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-store-"));
    const externalStore = path.join(externalDir, "sessions.json");
    await fs.writeFile(externalStore, contents, "utf8");
    const params = {
      ...fixture.params,
      config: { session: { store: externalStore } },
    };

    const result = await fixture.migration.migrateLegacyState(params);

    expect(result.changes).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("session index");
    expect(result.warnings[0]).toContain(detail);
    await expect(fs.access(fixture.sidecarPath)).resolves.toBeUndefined();
    await expect(fs.access(`${fixture.sidecarPath}.migrated`)).rejects.toThrow();
    await expect(openBindingStore(fixture.env).entries()).resolves.toEqual([]);

    await removeCodexDoctorFixture(fixture.stateDir);
    await fs.rm(externalDir, { recursive: true, force: true });
  });

  it("does not scan above stateDir or follow escaped external store locators", async () => {
    const outerDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-doctor-outer-"));
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-doctor-outside-"));
    const stateDir = path.join(outerDir, "state");
    await fs.mkdir(stateDir, { recursive: true });
    const strayDir = path.join(outerDir, "unrelated");
    await fs.mkdir(strayDir, { recursive: true });
    const externalStore = path.join(outerDir, "sessions.json");
    await fs.writeFile(
      path.join(strayDir, "foreign.jsonl.codex-app-server.json"),
      JSON.stringify({ schemaVersion: 2, threadId: "thread-foreign" }),
      "utf8",
    );
    await fs.writeFile(
      path.join(outsideDir, "foreign.jsonl.codex-app-server.json"),
      JSON.stringify({ schemaVersion: 2, threadId: "thread-escaped" }),
      "utf8",
    );
    await fs.symlink(outsideDir, path.join(outerDir, "escaped"));
    await fs.writeFile(
      externalStore,
      JSON.stringify({
        "agent:main:foreign": {
          sessionId: "foreign",
          // The transcript is missing, but the sidecar exists through an
          // escaping symlink. Containment must resolve the existing ancestor.
          sessionFile: "escaped/foreign.jsonl",
        },
      }),
      "utf8",
    );
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const params = {
      // The store directory is exactly stateDir's parent. It stays indexed-only,
      // and its explicit locator cannot escape that directory.
      config: { session: { store: externalStore } },
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: createDoctorContext(env),
    };
    const migration = stateMigrations[0];
    if (!migration) {
      throw new Error("missing Codex binding migration");
    }

    await expect(migration.detectLegacyState(params)).resolves.toBeNull();

    await removeCodexDoctorFixture(outerDir);
    await fs.rm(outsideDir, { recursive: true, force: true });
  });

  it("renames old approval-routed destructive plugin policy values", () => {
    const original = {
      plugins: {
        entries: {
          codex: {
            enabled: true,
            config: {
              codexDynamicToolsProfile: "openclaw-compat",
              codexPlugins: {
                enabled: true,
                allow_destructive_actions: "on-request",
                plugins: {
                  "google-calendar": {
                    enabled: true,
                    allow_destructive_actions: "on-request",
                  },
                  slack: {
                    enabled: true,
                    allow_destructive_actions: false,
                  },
                },
              },
            },
          },
        },
      },
    };

    const result = normalizeCompatibilityConfig({ cfg: original });

    expect(result.changes).toEqual([
      "Removed retired plugins.entries.codex.config.codexDynamicToolsProfile; Codex app-server always keeps Codex-native workspace tools native.",
      'Renamed plugins.entries.codex.config.codexPlugins allow_destructive_actions="on-request" values to "auto".',
    ]);
    expect(result.config.plugins?.entries?.codex?.config).toEqual({
      codexPlugins: {
        enabled: true,
        allow_destructive_actions: "auto",
        plugins: {
          "google-calendar": {
            enabled: true,
            allow_destructive_actions: "auto",
          },
          slack: {
            enabled: true,
            allow_destructive_actions: false,
          },
        },
      },
    });
    expect(
      original.plugins.entries.codex.config.codexPlugins.plugins["google-calendar"]
        .allow_destructive_actions,
    ).toBe("on-request");
  });

  it("renames the retired app-server on-failure approval policy", () => {
    const original = {
      plugins: {
        entries: {
          codex: {
            enabled: true,
            config: {
              appServer: {
                approvalPolicy: "on-failure",
                sandbox: "workspace-write",
              },
            },
          },
        },
      },
    };

    const result = normalizeCompatibilityConfig({ cfg: original });

    expect(result.changes).toEqual([
      'Renamed plugins.entries.codex.config.appServer.approvalPolicy="on-failure" to "on-request".',
    ]);
    expect(result.config.plugins?.entries?.codex?.config).toEqual({
      appServer: {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      },
    });
    expect(original.plugins.entries.codex.config.appServer.approvalPolicy).toBe("on-failure");
  });

  describe("orphaned session binding repair", () => {
    it("removes multiple pages of stale rows in bounded batches without touching live ownership", async () => {
      const fixture = createOrphanedBindingMigrationFixture();
      const stableOrphanCount = 1_137;
      const physicalOrphanCount = 73;
      for (let index = 0; index < stableOrphanCount; index += 1) {
        fixture.seedBinding({
          sessionId: `orphan-stable-${index}`,
          sessionKey: `agent:main:orphan-stable-${index}`,
        });
      }
      for (let index = 0; index < physicalOrphanCount; index += 1) {
        fixture.seedBinding({ sessionId: `orphan-physical-${index}` });
      }

      const currentStableKey = fixture.seedBinding({
        sessionId: "current-stable",
        sessionKey: "agent:main:current-stable",
      });
      fixture.setEvidence({
        agentId: "main",
        sessionId: "current-stable",
        state: "current",
        sessionKey: "agent:main:current-stable",
      });
      const currentPhysicalKey = fixture.seedBinding({ sessionId: "current-physical" });
      fixture.setEvidence({
        agentId: "main",
        sessionId: "current-physical",
        state: "current",
        sessionKey: "agent:main:current-physical",
      });
      const mismatchedStableKey = fixture.seedBinding({
        sessionId: "moved-stable",
        sessionKey: "agent:main:previous-stable-key",
      });
      fixture.setEvidence({
        agentId: "main",
        sessionId: "moved-stable",
        state: "current",
        sessionKey: "agent:main:replacement-stable-key",
      });

      const preservedKeys = [currentStableKey, currentPhysicalKey];
      const activeBinding = (sessionId: string, binding: Record<string, unknown> = {}) => ({
        version: 1,
        state: "active",
        sessionId,
        binding: { threadId: `thread-${sessionId}`, cwd: "/workspace", ...binding },
      });
      preservedKeys.push(
        fixture.seedBinding({
          sessionId: "leased",
          value: {
            ...activeBinding("leased"),
            lease: { token: "live-owner", expiresAt: Date.now() + 60_000 },
          },
        }),
        fixture.seedBinding({
          sessionId: "supervised",
          value: activeBinding("supervised", { connectionScope: "supervision" }),
        }),
        fixture.seedBinding({
          sessionId: "native-source",
          value: activeBinding("native-source", { supervisionSourceThreadId: "native-thread" }),
        }),
        fixture.seedBinding({
          sessionId: "pending-supervision",
          value: activeBinding("pending-supervision", {
            pendingSupervisionBranch: {
              sourceThreadId: "native-thread",
              cleanupThreadIds: ["pending-cleanup-thread"],
            },
          }),
        }),
        fixture.seedBinding({
          sessionId: "missing-session-id",
          value: { version: 1, state: "cleared" },
        }),
        fixture.seedBinding({
          sessionId: "malformed-row",
          value: { version: 1, state: "unrecognized", sessionId: "malformed-row" },
        }),
        fixture.seedBinding({
          key: "session-key:main:not-a-canonical-hash",
          sessionId: "malformed-key",
        }),
        fixture.seedBinding({
          key: "conversation:active-native-thread",
          sessionId: "conversation",
        }),
      );
      const unknownKey = fixture.seedBinding({ sessionId: "unavailable-session-store" });
      fixture.setEvidence({
        agentId: "main",
        sessionId: "unavailable-session-store",
        state: "unknown",
      });
      preservedKeys.push(unknownKey);

      fixture.seedBinding({
        sessionId: "retired-orphan",
        value: { version: 1, state: "cleared", sessionId: "retired-orphan", retired: true },
      });
      fixture.seedBinding({
        sessionId: "expired-lease",
        value: {
          ...activeBinding("expired-lease"),
          lease: { token: "expired-owner", expiresAt: Date.now() - 1_000 },
        },
      });
      const expectedDeleted = stableOrphanCount + physicalOrphanCount + 3;
      const initialRowCount = fixture.rows.size;

      expect(fixture.migration).toMatchObject({ doctorOnly: true, phase: "after-session-repair" });
      await expect(fixture.migration.detectLegacyState(fixture.params)).resolves.toMatchObject({
        preview: [expect.stringContaining("orphaned session ownership")],
      });
      expect(fixture.rows.size).toBe(initialRowCount);
      expect(fixture.deletionBatchSizes).toEqual([]);
      expect(fixture.pageReads).toHaveLength(1);
      fixture.pageReads.length = 0;
      fixture.evidenceBatchSizes.length = 0;

      await expect(fixture.migration.migrateLegacyState(fixture.params)).resolves.toEqual({
        changes: [`Removed ${expectedDeleted} orphaned Codex app-server session binding(s)`],
        warnings: [],
      });
      expect(fixture.rows.size).toBe(initialRowCount - expectedDeleted);
      expect(fixture.rows.has(mismatchedStableKey)).toBe(false);
      expect(preservedKeys.every((key) => fixture.rows.has(key))).toBe(true);
      expect(fixture.deletionBatchSizes.reduce((total, size) => total + size, 0)).toBe(
        expectedDeleted,
      );
      expect(fixture.deletionBatchSizes.length).toBeGreaterThan(2);
      expect(fixture.deletionBatchSizes.length).toBeLessThan(10);
      expect(fixture.deletionBatchSizes.every((size) => size > 1 && size <= 512)).toBe(true);
      expect(fixture.evidenceBatchSizes.every((size) => size <= 512)).toBe(true);
      expect(fixture.pageReads.every((page) => page.limit <= 512)).toBe(true);
      expect(fixture.pageReads.some((page) => page.after !== undefined)).toBe(true);

      const completedBatchCount = fixture.deletionBatchSizes.length;
      await expect(fixture.migration.detectLegacyState(fixture.params)).resolves.toBeNull();
      await expect(fixture.migration.migrateLegacyState(fixture.params)).resolves.toEqual({
        changes: [],
        warnings: [],
      });
      expect(fixture.deletionBatchSizes).toHaveLength(completedBatchCount);
    });

    it.each([
      { store: "initialized empty", state: "absent", retained: false },
      { store: "missing", state: "unknown", retained: true },
      { store: "broken", state: "unknown", retained: true },
      { store: "ambiguous", state: "unknown", retained: true },
    ] as const)(
      "treats a $store authoritative session store safely",
      async ({ state, retained }) => {
        const fixture = createOrphanedBindingMigrationFixture({ defaultEvidence: state });
        const bindingKey = fixture.seedBinding({
          sessionId: "orphan-or-unknown",
          sessionKey: "agent:main:orphan-or-unknown",
        });

        await fixture.migration.migrateLegacyState(fixture.params);

        expect(fixture.rows.has(bindingKey)).toBe(retained);
        expect(fixture.deletionBatchSizes).toHaveLength(retained ? 0 : 1);
      },
    );

    it("preserves an exact-row successor replacing the observed orphan before bulk deletion", async () => {
      const successor = {
        version: 1,
        state: "active",
        sessionId: "same-session-id",
        binding: { threadId: "replacement-native-thread", cwd: "/workspace" },
      };
      const fixture = createOrphanedBindingMigrationFixture({
        replaceBeforeDelete: (observed) => ({
          ...observed,
          value: successor,
          valueJson: JSON.stringify(successor),
        }),
      });
      const bindingKey = fixture.seedBinding({
        sessionId: "same-session-id",
        sessionKey: "agent:main:same-session-id",
      });

      await expect(fixture.migration.migrateLegacyState(fixture.params)).resolves.toEqual({
        changes: [],
        warnings: ["Preserved 1 Codex app-server session binding(s) changed during repair"],
      });

      expect(fixture.rows.get(bindingKey)?.value).toEqual(successor);
      expect(fixture.deletionBatchSizes).toEqual([1]);
    });

    it("preserves malformed physical rows while repairing valid siblings", async () => {
      const fixture = createOrphanedBindingMigrationFixture();
      const malformedKey = fixture.seedBinding({
        sessionId: "malformed-physical-row",
        valueJson: "{",
      });
      const staleKey = fixture.seedBinding({ sessionId: "valid-stale-sibling" });

      await expect(fixture.migration.migrateLegacyState(fixture.params)).resolves.toEqual({
        changes: ["Removed 1 orphaned Codex app-server session binding(s)"],
        warnings: [],
      });

      expect(fixture.rows.get(malformedKey)).toMatchObject({ valueJson: "{" });
      expect(fixture.rows.has(staleKey)).toBe(false);
    });

    it("preserves a same-value successor whose physical JSON bytes changed", async () => {
      const fixture = createOrphanedBindingMigrationFixture({
        replaceBeforeDelete: (observed) => ({
          ...observed,
          valueJson: JSON.stringify(observed.value, null, 2),
        }),
      });
      const bindingKey = fixture.seedBinding({ sessionId: "same-value-new-bytes" });

      await expect(fixture.migration.migrateLegacyState(fixture.params)).resolves.toEqual({
        changes: [],
        warnings: ["Preserved 1 Codex app-server session binding(s) changed during repair"],
      });

      expect(fixture.rows.get(bindingKey)?.valueJson).toContain("\n");
    });

    it.each([
      { state: "absent", retained: false },
      { state: "current", retained: true },
      { state: "unknown", retained: true },
    ] as const)(
      "repairs a deleted retirement tombstone only when ownership is $state",
      async ({ state, retained }) => {
        const fixture = createOrphanedBindingMigrationFixture();
        const sessionId = "deleted-retirement-generation";
        const key = fixture.seedBinding({
          sessionId,
          sessionKey: "agent:main:deleted-retirement-generation",
          value: {
            version: 1,
            state: "cleared",
            sessionId,
            retired: true,
            retirementReason: "deleted",
          },
        });
        fixture.setEvidence(
          state === "current"
            ? {
                agentId: "main",
                sessionId,
                state,
                sessionKey: "agent:main:new-owner",
              }
            : { agentId: "main", sessionId, state },
        );

        await fixture.migration.migrateLegacyState(fixture.params);

        expect(fixture.rows.has(key)).toBe(retained);
      },
    );

    it("refuses destructive repair without locked host ownership", async () => {
      const fixture = createOrphanedBindingMigrationFixture();
      const bindingKey = fixture.seedBinding({ sessionId: "unlocked-orphan" });
      const unlockedContext = {
        ...fixture.context,
        deletePluginStateEntriesIfUnchanged: undefined,
      };

      await expect(
        fixture.migration.migrateLegacyState({ ...fixture.params, context: unlockedContext }),
      ).resolves.toMatchObject({
        changes: [],
        warnings: [expect.stringContaining("locked SQLite maintenance ownership")],
      });
      expect(fixture.rows.has(bindingKey)).toBe(true);
      expect(fixture.deletionBatchSizes).toEqual([]);
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
