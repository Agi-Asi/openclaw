// Compare-and-swap session patches must reject reset replacements atomically.
import { afterEach, expect, test, vi } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { applySessionEntryCanonicalReplacements } from "../config/sessions/session-accessor.sqlite-replacement-projection.js";
import { createDeferredCore as createDeferred } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import * as patchContinuation from "./server-methods/session-patch-continuation.js";
import { embeddedRunMock, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  expectNoSessionQueueCleanup,
  sessionHookMocks,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

test.each([
  { action: "archive", archived: true },
  { action: "restore", archived: false },
])("sessions.patch rejects missing $action targets without creating rows", async ({ archived }) => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:missing-lifecycle-target";
  const broadcastToConnIds = vi.fn();
  await writeSessionStore({ entries: {} });

  const result = await directSessionReq(
    "sessions.patch",
    { key: sessionKey, archived },
    {
      context: {
        broadcastToConnIds,
        getSessionEventSubscriberConnIds: () => new Set(["session-observer"]),
      },
    },
  );

  expect(result).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST", message: `session not found: ${sessionKey}` },
  });
  expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
  expectNoSessionQueueCleanup();
  expect(sessionHookMocks.triggerInternalHook).not.toHaveBeenCalled();
  expect(broadcastToConnIds).not.toHaveBeenCalled();
});

test.each([
  { action: "archive", archived: true },
  { action: "restore", archived: false },
])(
  "sessions.patch reports deleted $action identity as a typed terminal non-outcome",
  async ({ archived }) => {
    const { storePath } = await createSessionStoreDir();
    const sessionKey = "agent:main:deleted-lifecycle-target";
    const broadcastToConnIds = vi.fn();
    await writeSessionStore({ entries: {} });

    const result = await directSessionReq(
      "sessions.patch",
      { key: sessionKey, archived, expectedSessionId: "session-a" },
      {
        context: {
          broadcastToConnIds,
          getSessionEventSubscriberConnIds: () => new Set(["session-observer"]),
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        details: { reason: "session-changed" },
      },
    });
    expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
    expect(sessionHookMocks.triggerInternalHook).not.toHaveBeenCalled();
    expect(broadcastToConnIds).not.toHaveBeenCalled();
  },
);

test.each([
  {
    name: "session id",
    expected: { expectedSessionId: "sess-before-reset" },
  },
  {
    name: "lifecycle revision",
    expected: { expectedLifecycleRevision: "revision-before-reset" },
  },
])("sessions.patch rejects a stale expected $name atomically", async ({ expected }) => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:subagent:archive-identity";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry("sess-after-reset", {
        lifecycleRevision: "revision-after-reset",
      }),
    },
  });

  const result = await directSessionReq("sessions.patch", {
    key: sessionKey,
    archived: true,
    ...expected,
  });

  expect(result).toMatchObject({
    ok: false,
    error: { message: `Session ${sessionKey} changed before patch. Retry.` },
  });
  expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
    sessionId: "sess-after-reset",
    lifecycleRevision: "revision-after-reset",
  });
  expect(loadSessionEntry({ sessionKey, storePath })).not.toHaveProperty("archivedAt");
});

test.each([
  { action: "archive", archived: true },
  { action: "restore", archived: false },
])(
  "sessions.patch rejects a replaced identity before projected $action side effects",
  async ({ archived }) => {
    const { storePath } = await createSessionStoreDir();
    const sessionKey = "agent:main:subagent:active-replacement";
    const replacementSessionId = "sess-active-after-reset";
    await writeSessionStore({
      entries: {
        [sessionKey]: sessionStoreEntry(replacementSessionId, {
          lifecycleRevision: "revision-after-reset",
        }),
      },
    });
    const replacementBefore = loadSessionEntry({ sessionKey, storePath });
    const broadcastToConnIds = vi.fn();
    embeddedRunMock.activeIds.add(replacementSessionId);

    const result = await directSessionReq(
      "sessions.patch",
      {
        key: sessionKey,
        archived,
        expectedSessionId: "sess-before-reset",
      },
      {
        context: {
          broadcastToConnIds,
          getSessionEventSubscriberConnIds: () => new Set(["session-observer"]),
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        message: `Session ${sessionKey} changed before patch. Retry.`,
        details: { reason: "session-changed" },
      },
    });
    expect(loadSessionEntry({ sessionKey, storePath })).toEqual(replacementBefore);
    expect(embeddedRunMock.abortCalls).toEqual([]);
    expect(sessionHookMocks.triggerInternalHook).not.toHaveBeenCalled();
    expect(broadcastToConnIds).not.toHaveBeenCalled();
  },
);

test("sessions.patch rejects a session replaced before restore reaches the SQLite writer", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:restore-generation-race";
  const originalSessionId = "restored-original";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(originalSessionId, { archivedAt: 1 }),
    },
  });

  const writerStarted = createDeferred();
  const replaceSession = createDeferred();
  const writer = applySessionEntryCanonicalReplacements({
    agentId: "main",
    sessionKeys: [sessionKey],
    storePath,
    update: async () => {
      writerStarted.resolve();
      await replaceSession.promise;
      return {
        replacements: [
          {
            entry: sessionStoreEntry("restored-replacement", { archivedAt: 2 }),
            previousSessionKeys: [],
            sessionKey,
          },
        ],
        result: undefined,
      };
    },
  });
  await writerStarted.promise;

  const preflightCompleted = createDeferred();
  const broadcastToConnIds = vi.fn();
  const restored = directSessionReq(
    "sessions.patch",
    {
      key: sessionKey,
      archived: false,
      expectedSessionId: originalSessionId,
    },
    {
      context: {
        broadcastToConnIds,
        getSessionEventSubscriberConnIds: () => new Set(["session-observer"]),
        workerSessionPlacementService: {
          getMany(sessionIds: readonly string[]) {
            if (sessionIds.includes(originalSessionId)) {
              preflightCompleted.resolve();
            }
            return new Map();
          },
        },
      },
    },
  );

  try {
    await preflightCompleted.promise;
    replaceSession.resolve();
    await writer;
    expect(await restored).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        details: { reason: "session-changed" },
      },
    });
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      archivedAt: 2,
      sessionId: "restored-replacement",
    });
    expect(sessionHookMocks.triggerInternalHook).not.toHaveBeenCalled();
    expect(broadcastToConnIds).not.toHaveBeenCalled();
  } finally {
    replaceSession.resolve();
    await Promise.allSettled([writer, restored]);
  }
});

test.each([
  {
    name: "session id",
    expected: { expectedSessionId: "sess-before-reset" },
  },
  {
    name: "lifecycle revision",
    expected: { expectedLifecycleRevision: "revision-before-reset" },
  },
])("sessions.patch rejects stale $name for metadata mutations", async ({ expected }) => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:subagent:metadata-identity";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry("sess-after-reset", {
        lifecycleRevision: "revision-after-reset",
      }),
    },
  });

  const patched = await directSessionReq("sessions.patch", {
    key: sessionKey,
    label: "Stale agent request",
    ...expected,
  });

  expect(patched).toMatchObject({
    ok: false,
    error: { message: `Session ${sessionKey} changed before patch. Retry.` },
  });
  expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
    sessionId: "sess-after-reset",
    lifecycleRevision: "revision-after-reset",
  });
  expect(loadSessionEntry({ sessionKey, storePath })).not.toHaveProperty("label");
});

test("sessions.patch archives the expected session under its lifecycle lock", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:subagent:archive-identity";
  const sessionId = "sess-expected-archive";
  const lifecycleRevision = "revision-expected-archive";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(sessionId, { lifecycleRevision }),
    },
  });

  const archived = await directSessionReq("sessions.patch", {
    key: sessionKey,
    archived: true,
    expectedSessionId: sessionId,
    expectedLifecycleRevision: lifecycleRevision,
  });

  expect(archived.ok).toBe(true);
  expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
    sessionId,
    lifecycleRevision,
    archivedAt: expect.any(Number),
  });
});

test("sessions.patch rejects an execution-authority mutation while exact session work is active", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:active-authority-patch";
  const sessionId = "session-active-authority-patch";
  const lifecycleRevision = "revision-active-authority-patch";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(sessionId, { lifecycleRevision }),
    },
  });
  embeddedRunMock.activeIds.add(sessionId);

  const patched = await directSessionReq("sessions.patch", {
    key: sessionKey,
    permissionMode: "full",
    expectedSessionId: sessionId,
    expectedLifecycleRevision: lifecycleRevision,
  });

  expect(patched).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST" },
  });
  expect(embeddedRunMock.abortCalls).toEqual([]);
  expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
    sessionId,
    lifecycleRevision,
  });
  expect(loadSessionEntry({ sessionKey, storePath })).not.toHaveProperty("permissionMode");
});

test("sessions.patch stops exact active work, rotates authority, and reports the visible note", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:stop-authority-patch";
  const sessionId = "session-stop-authority-patch";
  const lifecycleRevision = "revision-stop-authority-patch";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(sessionId, { lifecycleRevision }),
    },
  });
  embeddedRunMock.activeIds.add(sessionId);
  embeddedRunMock.waitResults.set(sessionId, true);

  const patched = await directSessionReq<{
    activeRun: { auditNote: string; policy: string; stopped: boolean };
    entry: { lifecycleRevision: string; permissionMode: string };
  }>("sessions.patch", {
    key: sessionKey,
    permissionMode: "full",
    activeRunPolicy: "stop",
    expectedSessionId: sessionId,
    expectedLifecycleRevision: lifecycleRevision,
  });

  expect(patched).toMatchObject({
    ok: true,
    payload: {
      activeRun: { auditNote: "appended", policy: "stop", stopped: true },
      entry: { permissionMode: "full" },
    },
  });
  expect(embeddedRunMock.abortCalls).toEqual([sessionId]);
  expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
    sessionId,
    permissionMode: "full",
    lifecycleRevision: expect.not.stringMatching(lifecycleRevision),
  });
});

test("sessions.patch keeps idle execution-authority patches compatible without explicit CAS", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:authority-patch-cas";
  const sessionId = "session-authority-patch-cas";
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });

  const patched = await directSessionReq("sessions.patch", {
    key: sessionKey,
    elevatedLevel: "full",
  });

  expect(patched).toMatchObject({
    ok: true,
    payload: { entry: { elevatedLevel: "full" } },
  });
  expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
    elevatedLevel: "full",
    sessionId,
  });
});

test("sessions.patch requires both CAS fields before stopping active authority", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:active-authority-patch-cas";
  const sessionId = "session-active-authority-patch-cas";
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
  embeddedRunMock.activeIds.add(sessionId);

  const patched = await directSessionReq("sessions.patch", {
    key: sessionKey,
    elevatedLevel: "full",
    activeRunPolicy: "stop",
    expectedSessionId: sessionId,
  });

  expect(patched).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST" },
  });
  expect(embeddedRunMock.abortCalls).toEqual([]);
  expect(loadSessionEntry({ sessionKey, storePath })).not.toHaveProperty("elevatedLevel");
});

test("sessions.patch requires both CAS fields for stop-and-continue while idle", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:idle-authority-continuation-cas";
  const sessionId = "session-idle-authority-continuation-cas";
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });

  const patched = await directSessionReq("sessions.patch", {
    key: sessionKey,
    elevatedLevel: "full",
    activeRunPolicy: "stop-and-continue",
  });

  expect(patched).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  expect(loadSessionEntry({ sessionKey, storePath })).not.toHaveProperty("elevatedLevel");
});

test("sessions.patchMany keeps execution-authority targets side-effect free while active", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:batch-active-authority-patch";
  const sessionId = "session-batch-active-authority-patch";
  const lifecycleRevision = "revision-batch-active-authority-patch";
  await writeSessionStore({
    entries: { [sessionKey]: sessionStoreEntry(sessionId, { lifecycleRevision }) },
  });
  embeddedRunMock.activeIds.add(sessionId);

  const patched = await directSessionReq<{
    outcomes: Array<{ error?: { code: string }; key: string; ok: boolean }>;
  }>("sessions.patchMany", {
    targets: [
      {
        key: sessionKey,
        expectedSessionId: sessionId,
        expectedLifecycleRevision: lifecycleRevision,
      },
    ],
    patch: { permissionMode: "full" },
  });

  expect(patched).toMatchObject({
    ok: true,
    payload: { outcomes: [{ key: sessionKey, ok: false, error: { code: "INVALID_REQUEST" } }] },
  });
  expect(embeddedRunMock.abortCalls).toEqual([]);
  expect(loadSessionEntry({ sessionKey, storePath })).not.toHaveProperty("permissionMode");
});

test("sessions.patch returns a continuation rejection without hiding the committed patch", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:authority-continuation-rejection";
  const sessionId = "session-authority-continuation-rejection";
  const lifecycleRevision = "revision-authority-continuation-rejection";
  await writeSessionStore({
    entries: { [sessionKey]: sessionStoreEntry(sessionId, { lifecycleRevision }) },
  });
  embeddedRunMock.activeIds.add(sessionId);
  embeddedRunMock.waitResults.set(sessionId, true);
  const launch = vi.spyOn(patchContinuation, "launchSessionPatchContinuation").mockResolvedValue({
    status: "rejected",
    error: { code: "UNAVAILABLE", message: "continuation unavailable" },
  });

  try {
    const patched = await directSessionReq<{
      activeRun: {
        continuation: { error: { message: string }; status: string };
        policy: string;
        stopped: boolean;
      };
      entry: { lifecycleRevision: string; permissionMode: string };
    }>("sessions.patch", {
      key: sessionKey,
      permissionMode: "full",
      activeRunPolicy: "stop-and-continue",
      expectedSessionId: sessionId,
      expectedLifecycleRevision: lifecycleRevision,
    });

    expect(patched).toMatchObject({
      ok: true,
      payload: {
        activeRun: {
          continuation: {
            error: { message: "continuation unavailable" },
            status: "rejected",
          },
          policy: "stop-and-continue",
          stopped: true,
        },
        entry: { permissionMode: "full" },
      },
    });
    expect(launch).toHaveBeenCalledOnce();
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      permissionMode: "full",
      lifecycleRevision: expect.not.stringMatching(lifecycleRevision),
    });
  } finally {
    launch.mockRestore();
  }
});
