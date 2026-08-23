// Doctor repairs incident-scale Codex plugin state only after durable session convergence.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createPluginStateKeyedStore,
  getPluginStateCapacity,
  resetPluginStateStoreForTests,
} from "../plugin-state/plugin-state-store.js";
import { seedPluginStateEntriesForTests } from "../plugin-state/plugin-state-store.test-helpers.js";
import type { PluginDoctorStateMigration } from "../plugins/doctor-contract-registry.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";

const note = vi.hoisted(() => vi.fn());

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

vi.mock("../plugins/doctor-contract-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/doctor-contract-registry.js")>();
  const { loadBundledPluginPublicSurface } =
    await import("../plugin-sdk/test-helpers/public-surface-loader.js");
  const { stateMigrations } = await loadBundledPluginPublicSurface<{
    stateMigrations: PluginDoctorStateMigration[];
  }>({ pluginId: "codex", artifactBasename: "doctor-contract-api.js" });
  return {
    ...actual,
    listPluginDoctorStateMigrationEntries: () =>
      stateMigrations.map((migration) => ({ pluginId: "codex", migration })),
  };
});

import { noteSessionTranscriptHealth } from "./doctor-session-transcripts.js";

const BINDING_NAMESPACE = "app-server-thread-bindings";
const MANAGED_THREAD_NAMESPACE = "app-server-managed-threads";
const ORPHANED_BINDING_COUNT = 47_794;
const ADVISORY_MANAGED_THREAD_COUNT = 2_206;
const PLUGIN_STATE_CAPACITY = 50_000;

let incidentStateDir: string | undefined;

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  resetPluginStateStoreForTests();
  vi.unstubAllEnvs();
  note.mockClear();
  if (incidentStateDir) {
    await fs.rm(incidentStateDir, { recursive: true, force: true });
    incidentStateDir = undefined;
  }
});

describe("doctor incident-scale Codex binding repair", () => {
  it("repairs 47,794 orphaned SQLite bindings while preserving 2,206 managed-thread rows", async () => {
    incidentStateDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-doctor-incident-")),
    );
    vi.stubEnv("OPENCLAW_STATE_DIR", incidentStateDir);
    const env = process.env;
    const config: OpenClawConfig = {
      agents: { entries: { main: { default: true } } },
      plugins: { entries: { codex: { enabled: true } } },
    };

    // A canonical, initialized empty store is positive absence evidence after the owner closes it.
    openOpenClawAgentDatabase({ agentId: "main", env });

    const rows: Parameters<typeof seedPluginStateEntriesForTests>[0] = [];
    for (let index = 0; index < ORPHANED_BINDING_COUNT; index += 1) {
      const sessionId = `incident-session-${index}`;
      rows.push({
        pluginId: "codex",
        namespace: BINDING_NAMESPACE,
        key: `session:main:${sessionId}`,
        value: {
          version: 1,
          state: "active",
          sessionId,
          binding: { threadId: `incident-thread-${index}`, cwd: "/workspace" },
        },
      });
    }
    for (let index = 0; index < ADVISORY_MANAGED_THREAD_COUNT; index += 1) {
      rows.push({
        pluginId: "codex",
        namespace: MANAGED_THREAD_NAMESPACE,
        key: `sha256:${index.toString(16).padStart(64, "0")}`,
        value: {
          version: 1,
          kind: "managed-thread",
          sourceHomeId: "incident-source-home",
          threadId: `managed-thread-${index}`,
        },
      });
    }
    seedPluginStateEntriesForTests(rows);

    expect(getPluginStateCapacity("codex", env)).toEqual({
      liveEntries: PLUGIN_STATE_CAPACITY,
      maxEntries: PLUGIN_STATE_CAPACITY,
    });

    const runActualDoctorRepair = () =>
      noteSessionTranscriptHealth({
        cfg: config,
        env,
        sessionDirs: [],
        sessionSqlite: true,
        shouldRepair: true,
      });

    await runActualDoctorRepair();

    expect(getPluginStateCapacity("codex", env)).toEqual({
      liveEntries: ADVISORY_MANAGED_THREAD_COUNT,
      maxEntries: PLUGIN_STATE_CAPACITY,
    });
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining(`Removed ${ORPHANED_BINDING_COUNT} orphaned Codex`),
      expect.any(String),
    );

    const managedThreads = createPluginStateKeyedStore<{ threadId: string }>("codex", {
      namespace: MANAGED_THREAD_NAMESPACE,
      maxEntries: 20_000,
      overflowPolicy: "evict-oldest",
      env,
    });
    const preservedRows = await managedThreads.entries();
    expect(preservedRows).toHaveLength(ADVISORY_MANAGED_THREAD_COUNT);
    expect(new Set(preservedRows.map((entry) => entry.value.threadId)).size).toBe(
      ADVISORY_MANAGED_THREAD_COUNT,
    );

    // Exercise the real cap instead of inferring recovered capacity from the row count.
    const bindings = createPluginStateKeyedStore<{ recovered: boolean }>("codex", {
      namespace: BINDING_NAMESPACE,
      maxEntries: PLUGIN_STATE_CAPACITY,
      overflowPolicy: "reject-new",
      env,
    });
    await bindings.register("conversation:recovered-headroom", { recovered: true });
    expect(await bindings.lookup("conversation:recovered-headroom")).toEqual({
      recovered: true,
    });
    await bindings.delete("conversation:recovered-headroom");

    note.mockClear();
    await runActualDoctorRepair();

    expect(getPluginStateCapacity("codex", env)).toEqual({
      liveEntries: ADVISORY_MANAGED_THREAD_COUNT,
      maxEntries: PLUGIN_STATE_CAPACITY,
    });
    expect(await managedThreads.entries()).toHaveLength(ADVISORY_MANAGED_THREAD_COUNT);
    expect(note.mock.calls.flat().join("\n")).not.toContain("orphaned Codex");
  }, 120_000);
});
