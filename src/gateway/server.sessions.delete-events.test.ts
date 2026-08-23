import fs from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { embeddedRunMock, rpcReq, writeSessionStore } from "./test-helpers.js";
import {
  browserSessionTabMocks,
  bundleMcpRuntimeMocks,
  directSessionReq,
  expectActiveRunCleanup,
  sessionLifecycleHookMocks,
  sessionStoreEntry,
  setupGatewaySessionsTestHarness,
  subagentLifecycleHookMocks,
  subagentLifecycleHookState,
  threadBindingMocks,
  writeSingleLineSession,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

type SessionDeleteRequest = {
  key: string;
  deleteTranscript?: boolean;
  emitLifecycleHooks?: boolean;
};

async function expectSessionDeleteSucceeds(request: SessionDeleteRequest) {
  const deleted = await directSessionReq<{ ok: true; deleted: boolean }>(
    "sessions.delete",
    request,
  );
  expect(deleted.ok).toBe(true);
  expect(deleted.payload?.deleted).toBe(true);
  return deleted;
}

async function seedSubagentWorkerSession() {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-subagent", "hello");
  await writeSessionStore({
    entries: {
      "agent:main:subagent:worker": sessionStoreEntry("sess-subagent"),
    },
  });
}

function expectThreadBindingsUnbound(targetSessionKey: string) {
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
    targetSessionKey,
    reason: "session-delete",
  });
}

test("sessions.delete emits session_end with deleted reason and no replacement", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "hello");

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main"),
      "discord:group:delete": sessionStoreEntry("sess-delete"),
    },
  });

  await expectSessionDeleteSucceeds({
    key: "discord:group:delete",
  });
  expect(sessionLifecycleHookMocks.runSessionEnd).toHaveBeenCalledTimes(1);
  expect(sessionLifecycleHookMocks.runSessionStart).not.toHaveBeenCalled();

  const [event, context] = (
    sessionLifecycleHookMocks.runSessionEnd.mock.calls as unknown as Array<[unknown, unknown]>
  )[0] ?? [undefined, undefined];
  expect((event as { sessionId?: string } | undefined)?.sessionId).toBe("sess-delete");
  expect((event as { sessionKey?: string } | undefined)?.sessionKey).toBe(
    "agent:main:discord:group:delete",
  );
  expect((event as { reason?: string } | undefined)?.reason).toBe("deleted");
  expect(
    (event as { transcriptArchived?: boolean } | undefined)?.transcriptArchived,
  ).toBeUndefined();
  expect((event as { sessionFile?: string } | undefined)?.sessionFile).toBeUndefined();
  expect((event as { nextSessionId?: string } | undefined)?.nextSessionId).toBeUndefined();
  expect((context as { sessionId?: string } | undefined)?.sessionId).toBe("sess-delete");
  expect((context as { sessionKey?: string } | undefined)?.sessionKey).toBe(
    "agent:main:discord:group:delete",
  );
  expect((context as { agentId?: string } | undefined)?.agentId).toBe("main");
});

test("sessions.delete sessions.changed event always carries the resolved owner", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-side", "hello");
  await writeSessionStore({ entries: { "agent:main:side": sessionStoreEntry("sess-side") } });
  const broadcastToConnIds = vi.fn();

  const deleted = await directSessionReq<{ deleted: boolean }>(
    "sessions.delete",
    { key: "agent:main:side", deleteTranscript: true },
    {
      client: { connect: { scopes: ["operator.admin"] } } as never,
      context: {
        broadcastToConnIds,
        getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
      },
    },
  );

  expect(deleted).toMatchObject({ ok: true, payload: { deleted: true } });
  expect(broadcastToConnIds).toHaveBeenCalledWith(
    "sessions.changed",
    expect.objectContaining({ sessionKey: "agent:main:side", agentId: "main", reason: "delete" }),
    new Set(["conn-1"]),
    { agentId: "main", dropIfSlow: true },
  );
});

test("sessions.delete does not emit lifecycle events when nothing was deleted", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "hello");
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main"),
    },
  });

  const deleted = await directSessionReq<{ ok: true; deleted: boolean }>("sessions.delete", {
    key: "agent:main:subagent:missing",
  });

  expect(deleted.ok).toBe(true);
  expect(deleted.payload?.deleted).toBe(false);
  expect(subagentLifecycleHookMocks.runSubagentEnded).not.toHaveBeenCalled();
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).not.toHaveBeenCalled();
});

test("sessions.delete emits subagent targetKind for subagent sessions", async () => {
  await seedSubagentWorkerSession();

  await expectSessionDeleteSucceeds({
    key: "agent:main:subagent:worker",
  });
  expect(subagentLifecycleHookMocks.runSubagentEnded).toHaveBeenCalledTimes(1);
  const event = (subagentLifecycleHookMocks.runSubagentEnded.mock.calls as unknown[][])[0]?.[0] as
    | { targetKind?: string; targetSessionKey?: string; reason?: string; outcome?: string }
    | undefined;
  expect(event?.targetSessionKey).toBe("agent:main:subagent:worker");
  expect(event?.targetKind).toBe("subagent");
  expect(event?.reason).toBe("session-delete");
  expect(event?.outcome).toBe("deleted");
  expectThreadBindingsUnbound("agent:main:subagent:worker");
});

test("sessions.delete can skip lifecycle hooks while still unbinding thread bindings", async () => {
  await seedSubagentWorkerSession();

  await expectSessionDeleteSucceeds({
    key: "agent:main:subagent:worker",
    emitLifecycleHooks: false,
  });
  expect(subagentLifecycleHookMocks.runSubagentEnded).not.toHaveBeenCalled();
  expectThreadBindingsUnbound("agent:main:subagent:worker");
});

test("sessions.delete directly unbinds thread bindings when hooks are unavailable", async () => {
  await seedSubagentWorkerSession();
  subagentLifecycleHookState.hasSubagentEndedHook = false;

  const deleted = await directSessionReq<{ ok: true; deleted: boolean }>("sessions.delete", {
    key: "agent:main:subagent:worker",
  });
  expect(deleted.ok).toBe(true);
  expect(subagentLifecycleHookMocks.runSubagentEnded).not.toHaveBeenCalled();
  expectThreadBindingsUnbound("agent:main:subagent:worker");
});

test("sessions.delete returns unavailable when active run does not stop", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-active", "active");

  await writeSessionStore({
    entries: {
      "discord:group:dev": sessionStoreEntry("sess-active"),
    },
  });

  embeddedRunMock.activeIds.add("sess-active");
  embeddedRunMock.waitResults.set("sess-active", false);
  const waitCallCountsAtRetirement: number[] = [];
  bundleMcpRuntimeMocks.retireSessionMcpRuntime.mockImplementation(async () => {
    waitCallCountsAtRetirement.push(embeddedRunMock.waitCalls.length);
    return true;
  });

  const { ws } = await openClient();

  const deleted = await rpcReq(ws, "sessions.delete", {
    key: "discord:group:dev",
  });
  expect(deleted.ok).toBe(false);
  expect(deleted.error?.code).toBe("UNAVAILABLE");
  expect(deleted.error?.message ?? "").toMatch(/still active/i);
  expectActiveRunCleanup(
    "agent:main:discord:group:dev",
    ["discord:group:dev", "agent:main:discord:group:dev", "sess-active"],
    "sess-active",
  );
  expect(bundleMcpRuntimeMocks.retireSessionMcpRuntime).toHaveBeenCalledWith({
    sessionId: "sess-active",
    reason: "gateway-session-cleanup",
    preserveActiveLeases: true,
    retainAcrossReuse: true,
    onError: expect.any(Function),
  });
  expect(bundleMcpRuntimeMocks.retireSessionMcpRuntime).toHaveBeenCalledTimes(2);
  expect(waitCallCountsAtRetirement).toEqual([0, 1]);
  expect(browserSessionTabMocks.closeTrackedBrowserTabsForSessions).not.toHaveBeenCalled();

  const storedEntry = loadSessionEntry({
    sessionKey: "agent:main:discord:group:dev",
    storePath,
  });
  expect(storedEntry?.sessionId).toBe("sess-active");
  const filesAfterDeleteAttempt = await fs.readdir(dir);
  expect(
    filesAfterDeleteAttempt.filter((fileName) => fileName.startsWith("sess-active.jsonl.deleted.")),
  ).toEqual([]);

  ws.close();
});
