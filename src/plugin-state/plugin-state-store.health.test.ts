import { chmodSync, existsSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearOpenClawDatabaseQuarantine,
  recordOpenClawDatabaseQuarantine,
} from "../state/openclaw-quarantine-store.js";
import {
  clearOpenClawStateDatabaseOpenFailure,
  OPENCLAW_STATE_SCHEMA_VERSION,
  openOpenClawStateDatabase,
  recordOpenClawStateDatabaseOpenFailure,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  createOpenClawTestState,
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  closePluginStateDatabase,
  createPluginStateKeyedStore,
  resetPluginStateStoreForTests,
} from "./plugin-state-store.js";
import {
  clearPluginStateStoreForTests,
  probePluginStateStore,
} from "./plugin-state-store.test-helpers.js";

let testState: OpenClawTestState | undefined;

beforeAll(async () => {
  testState = await createOpenClawTestState({ label: "plugin-state-store-health" });
  rmSync(path.dirname(resolveOpenClawStateSqlitePath()), { recursive: true, force: true });
});

beforeEach(() => {
  testState?.applyEnv();
  clearPluginStateStoreForTests();
});

afterEach(() => {
  vi.useRealTimers();
  resetPluginStateStoreForTests({ closeDatabase: false });
});

afterAll(async () => {
  resetPluginStateStoreForTests();
  await testState?.cleanup();
});

describe("plugin state store health", () => {
  it("treats a missing database as empty without creating it", async () => {
    await withOpenClawTestState(
      { label: "plugin-state-read-only-missing", applyEnv: false },
      async (state) => {
        const store = createPluginStateKeyedStore("discord", {
          namespace: "read-only-missing",
          maxEntries: 10,
          env: state.env,
        });
        const databasePath = resolveOpenClawStateSqlitePath(state.env);

        expect(existsSync(databasePath)).toBe(false);
        await expect(store.lookup("k")).resolves.toBeUndefined();
        await expect(store.entries()).resolves.toEqual([]);
        expect(existsSync(databasePath)).toBe(false);
      },
    );
  });

  it("fails closed for process-local and persisted database quarantine", async () => {
    const store = createPluginStateKeyedStore("discord", {
      namespace: "quarantine",
      maxEntries: 10,
    });
    await store.register("k", { ok: true });
    const databasePath = resolveOpenClawStateSqlitePath(testState?.env);
    closePluginStateDatabase();

    recordOpenClawStateDatabaseOpenFailure(databasePath, new Error("latched failure"));
    await expect(store.lookup("k")).rejects.toMatchObject({
      code: "PLUGIN_STATE_OPEN_FAILED",
      path: databasePath,
    });
    clearOpenClawStateDatabaseOpenFailure(databasePath);

    expect(
      recordOpenClawDatabaseQuarantine({
        env: testState?.env,
        kind: "state",
        path: databasePath,
        reason: "persisted failure",
      }),
    ).toBe(true);
    await expect(store.lookup("k")).rejects.toMatchObject({
      code: "PLUGIN_STATE_OPEN_FAILED",
      path: databasePath,
    });
    expect(clearOpenClawDatabaseQuarantine(databasePath, { env: testState?.env })).toBe(true);
  });

  it("fails closed for a newer shared-state schema", async () => {
    const store = createPluginStateKeyedStore("discord", {
      namespace: "newer-schema",
      maxEntries: 10,
    });
    await store.register("k", { ok: true });
    const databasePath = resolveOpenClawStateSqlitePath(testState?.env);
    openOpenClawStateDatabase().db.exec(
      `PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};`,
    );
    closePluginStateDatabase();

    try {
      await expect(store.lookup("k")).rejects.toMatchObject({
        code: "PLUGIN_STATE_OPEN_FAILED",
        path: databasePath,
      });
    } finally {
      const database = new DatabaseSync(databasePath);
      try {
        database.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};`);
      } finally {
        database.close();
      }
    }
  });

  it.runIf(process.platform !== "win32")(
    "reports inaccessible explicit state directories instead of treating them as empty",
    async () => {
      const store = createPluginStateKeyedStore("discord", {
        namespace: "inaccessible",
        maxEntries: 10,
      });
      await store.register("k", { ok: true });
      const databasePath = resolveOpenClawStateSqlitePath(testState?.env);
      closePluginStateDatabase();
      chmodSync(testState?.stateDir ?? "", 0o000);
      try {
        await expect(store.lookup("k")).rejects.toMatchObject({
          code: "PLUGIN_STATE_OPEN_FAILED",
          path: databasePath,
        });
      } finally {
        chmodSync(testState?.stateDir ?? "", 0o700);
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "reuses a process-held state database when its directory becomes inaccessible",
    async () => {
      const store = createPluginStateKeyedStore("discord", {
        namespace: "inaccessible-open-handle",
        maxEntries: 10,
      });
      await store.register("k", { ok: true });
      const database = openOpenClawStateDatabase();
      chmodSync(testState?.stateDir ?? "", 0o000);
      try {
        await expect(store.lookup("k")).resolves.toEqual({ ok: true });
        expect(database.db.isOpen).toBe(true);
      } finally {
        chmodSync(testState?.stateDir ?? "", 0o700);
      }
    },
  );

  it("does not close a shared database opened before the plugin-state probe", () => {
    const database = openOpenClawStateDatabase();
    const result = probePluginStateStore();

    expect(result.ok).toBe(true);
    expect(database.db.isOpen).toBe(true);
  });

  it("reopens after the shared state DB cache closes its handle", async () => {
    const store = createPluginStateKeyedStore("discord", {
      namespace: "cache-switch",
      maxEntries: 10,
    });
    await store.register("k", { ok: true });

    const secondary = await createOpenClawTestState({
      label: "plugin-state-cache-secondary",
      applyEnv: false,
    });
    try {
      openOpenClawStateDatabase({ env: secondary.env });
      testState?.applyEnv();
      await expect(store.lookup("k")).resolves.toEqual({ ok: true });
    } finally {
      await secondary.cleanup();
    }
  });

  it.runIf(process.platform !== "win32")("hardens DB directory and file permissions", async () => {
    const store = createPluginStateKeyedStore("discord", { namespace: "perms", maxEntries: 10 });
    await store.register("k", { ok: true });

    const databasePath = resolveOpenClawStateSqlitePath();
    expect(statSync(path.dirname(databasePath)).mode & 0o777).toBe(0o700);
    expect(statSync(databasePath).mode & 0o777).toBe(0o600);
  });

  it("reports healthy diagnostics without stored values", () => {
    const result = probePluginStateStore();
    expect(result.ok).toBe(true);
    expect(result.steps.filter((step) => !step.ok)).toStrictEqual([]);
    expect(JSON.stringify(result)).not.toContain("probe-value");
  });

  it("reports an unhealthy probe when the clock cannot produce a valid ttl expiry", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(MAX_DATE_TIMESTAMP_MS);
    try {
      const result = probePluginStateStore();
      expect(result.ok).toBe(false);
      expect(result.steps).toContainEqual(
        expect.objectContaining({
          name: "probe",
          ok: false,
          code: "PLUGIN_STATE_INVALID_INPUT",
        }),
      );
    } finally {
      nowSpy.mockRestore();
    }
  });
});
