import path from "node:path";
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { PluginSessionDeletionFinalizer } from "../../plugins/plugin-api.types.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createPluginRecord } from "../../plugins/status.test-fixtures.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import {
  applySessionEntryLifecycleMutation,
  deleteSessionEntryLifecycle,
  ensureSessionEntrySync,
  loadSessionEntry,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "./session-accessor.js";
import { applySessionEntryCanonicalReplacements } from "./session-accessor.sqlite-replacement-projection.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const SESSION_TEST_HARNESS_ID = "test-harness";

function registerSessionDeletionFinalizer(handler: PluginSessionDeletionFinalizer): void {
  const fixture = createPluginRegistryFixture();
  registerTestPlugin({
    ...fixture,
    record: createPluginRecord({
      agentHarnessIds: [SESSION_TEST_HARNESS_ID],
      id: "session-cleanup-owner",
    }),
    register(api) {
      api.onSessionDeleted?.({ agentHarnessId: SESSION_TEST_HARNESS_ID, handler });
    },
  });
  setActivePluginRegistry(fixture.registry.registry);
}

describe("SQLite session deletion finalization", () => {
  let storePath: string;

  beforeEach(() => {
    const tempDir = tempDirs.make("openclaw-session-deletion-finalization-");
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    closeOpenClawAgentDatabasesForTest();
  });

  it("awaits exact-generation cleanup and blocks same-id recreation", async () => {
    const sessionKey = "agent:main:awaited-deletion-owner";
    const sessionId = "awaited-deletion-session";
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        agentHarnessId: SESSION_TEST_HARNESS_ID,
        sessionId,
        lifecycleRevision: "deleted-generation",
        updatedAt: Date.now(),
      },
    );
    const started = createDeferred();
    const release = createDeferred();
    const finalized: Array<{ sessionKey: string; sessionId: string; lifecycleRevision?: string }> =
      [];
    registerSessionDeletionFinalizer(async (event, { assertCurrent }) => {
      started.resolve();
      await release.promise;
      assertCurrent();
      finalized.push(event);
    });

    const deletion = deleteSessionEntryLifecycle({
      archiveTranscript: false,
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    });
    await started.promise;
    expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
    const successorEntry = {
      agentHarnessId: SESSION_TEST_HARNESS_ID,
      sessionId,
      lifecycleRevision: "successor-generation",
      updatedAt: Date.now(),
    };
    expect(() => replaceSessionEntrySync({ sessionKey, storePath }, successorEntry)).toThrow(
      "session deletion finalization is still in progress",
    );
    expect(() => ensureSessionEntrySync({ sessionKey, storePath }, successorEntry)).toThrow(
      "session deletion finalization is still in progress",
    );

    let recreated = false;
    const successor = replaceSessionEntry({ sessionKey, storePath }, successorEntry).then(
      (entry) => {
        recreated = true;
        return entry;
      },
    );
    await Promise.resolve();
    expect(recreated).toBe(false);

    release.resolve();
    await expect(deletion).resolves.toMatchObject({ deleted: true });
    await expect(successor).resolves.toMatchObject(successorEntry);
    expect(finalized).toEqual([
      {
        agentHarnessId: SESSION_TEST_HARNESS_ID,
        sessionKey,
        sessionId,
        lifecycleRevision: "deleted-generation",
        agentId: "main",
      },
    ]);
  });

  it("does not complete automatic maintenance before cleanup settles", async () => {
    const sessionKey = "agent:main:awaited-maintenance-owner";
    const sessionId = "awaited-maintenance-session";
    await replaceSessionEntry(
      { sessionKey, storePath },
      { agentHarnessId: SESSION_TEST_HARNESS_ID, sessionId, updatedAt: 1 },
    );
    const started = createDeferred();
    const release = createDeferred();
    registerSessionDeletionFinalizer(async (event) => {
      expect(event).toMatchObject({ sessionKey, sessionId });
      started.resolve();
      await release.promise;
    });

    let completed = false;
    const maintenance = applySessionEntryLifecycleMutation({
      storePath,
      maintenanceOverride: { mode: "enforce", pruneAfterMs: 1 },
    }).then((result) => {
      completed = true;
      return result;
    });
    await started.promise;
    expect(completed).toBe(false);
    expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();

    release.resolve();
    await expect(maintenance).resolves.toMatchObject({ afterCount: 0, pruned: 1 });
    expect(completed).toBe(true);
  });

  it("rejects competing admitted deletion but permits the caller admission", async () => {
    const sessionKey = "agent:main:competing-deletion-owner";
    const sessionId = "competing-deletion-session";
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: Date.now() });
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [sessionKey, sessionId],
      assertAllowed: () => {},
    });

    try {
      await expect(
        deleteSessionEntryLifecycle({
          archiveTranscript: false,
          storePath,
          target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
        }),
      ).rejects.toThrow("competing work is in flight");
      expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({ sessionId });

      await expect(
        admission.run(async () =>
          deleteSessionEntryLifecycle({
            archiveTranscript: false,
            storePath,
            target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
          }),
        ),
      ).resolves.toMatchObject({ deleted: true });
    } finally {
      admission.release();
    }
  });

  it("preserves a rehomed alias generation without destructive finalization", async () => {
    const previousKey = "agent:main:finalized-alias-previous";
    const canonicalKey = "agent:main:finalized-alias-canonical";
    const sessionId = "finalized-alias-session";
    await replaceSessionEntry(
      { sessionKey: previousKey, storePath },
      {
        agentHarnessId: SESSION_TEST_HARNESS_ID,
        sessionId,
        lifecycleRevision: "alias-generation",
        updatedAt: Date.now(),
      },
    );
    const finalized = vi.fn();
    registerSessionDeletionFinalizer(finalized);

    await applySessionEntryCanonicalReplacements({
      sessionKeys: [canonicalKey, previousKey],
      storePath,
      update: (entries) => ({
        replacements: [
          {
            entry: entries.find(({ sessionKey }) => sessionKey === previousKey)!.entry,
            previousSessionKeys: [previousKey],
            sessionKey: canonicalKey,
          },
        ],
        result: undefined,
      }),
    });

    expect(finalized).not.toHaveBeenCalled();
    expect(loadSessionEntry({ sessionKey: previousKey, storePath })).toBeUndefined();
    expect(loadSessionEntry({ sessionKey: canonicalKey, storePath })).toMatchObject({ sessionId });
  });

  it("surfaces committed finalizer failures", async () => {
    const sessionKey = "agent:main:failed-deletion-owner";
    const sessionId = "failed-deletion-session";
    await replaceSessionEntry(
      { sessionKey, storePath },
      { agentHarnessId: SESSION_TEST_HARNESS_ID, sessionId, updatedAt: Date.now() },
    );
    registerSessionDeletionFinalizer(() => {
      throw new Error("plugin owner refused cleanup");
    });

    await expect(
      deleteSessionEntryLifecycle({
        archiveTranscript: false,
        storePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      }),
    ).rejects.toThrow(
      "session row committed; plugin cleanup incomplete; run openclaw doctor --fix",
    );
    expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
  });

  it("preserves an atomically replaced same-id lifecycle generation", async () => {
    const sessionKey = "agent:main:atomic-same-id-owner";
    const entry = {
      agentHarnessId: SESSION_TEST_HARNESS_ID,
      sessionId: "atomic-same-id-session",
      lifecycleRevision: "previous-generation",
      updatedAt: Date.now(),
    };
    await replaceSessionEntry({ sessionKey, storePath }, entry);
    const finalized = vi.fn();
    registerSessionDeletionFinalizer(finalized);

    await applySessionEntryLifecycleMutation({
      storePath,
      removals: [{ sessionKey, expectedEntry: entry }],
      upserts: [
        {
          sessionKey,
          buildEntry: () => ({ ...entry, lifecycleRevision: "successor-generation" }),
        },
      ],
      skipMaintenance: true,
    });

    expect(finalized).not.toHaveBeenCalled();
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      sessionId: entry.sessionId,
      lifecycleRevision: "successor-generation",
    });
  });
});
