import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, expect, test } from "vitest";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-fixtures.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  sessionStoreEntry,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsTestHarness();

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

test("sessions.delete awaits exact-generation finalization before same-id recreation", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:subagent:finalizer-owner";
  const sessionId = "sess-finalizer-owner";
  const lifecycleRevision = "finalizer-owner-revision";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(sessionId, {
        agentHarnessId: "test-harness",
        lifecycleRevision,
      }),
    },
  });

  const bindings = new Map([[sessionKey, "retired-generation"]]);
  const previousRegistry = getActivePluginRegistry();
  const fixture = createPluginRegistryFixture();
  const record = createPluginRecord({
    agentHarnessIds: ["test-harness"],
    id: "session-finalizer-owner",
  });
  let notifyFinalizationStarted = () => {};
  const finalizationStarted = new Promise<void>((resolve) => {
    notifyFinalizationStarted = resolve;
  });
  let releaseFinalization = () => {};
  const finalizationReleased = new Promise<void>((resolve) => {
    releaseFinalization = resolve;
  });
  registerTestPlugin({
    ...fixture,
    record,
    register(api) {
      api.onSessionDeleted?.({
        agentHarnessId: "test-harness",
        handler: async (event, { assertCurrent }) => {
          expect(event).toEqual({
            agentHarnessId: "test-harness",
            agentId: "main",
            sessionKey,
            sessionId,
            lifecycleRevision,
          });
          assertCurrent();
          notifyFinalizationStarted();
          await finalizationReleased;
          assertCurrent();
          if (bindings.get(sessionKey) === "retired-generation") {
            bindings.delete(sessionKey);
          }
        },
      });
    },
  });
  setActivePluginRegistry(fixture.registry.registry);

  try {
    let deletionCompleted = false;
    const deletion = directSessionReq<{ deleted: boolean }>("sessions.delete", {
      key: sessionKey,
      expectedSessionId: sessionId,
      expectedLifecycleRevision: lifecycleRevision,
    }).then((result) => {
      deletionCompleted = true;
      return result;
    });
    await finalizationStarted;
    expect(deletionCompleted).toBe(false);
    expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();

    let successorCreated = false;
    const successor = replaceSessionEntry(
      { agentId: "main", sessionKey, storePath },
      sessionStoreEntry(sessionId, { lifecycleRevision: "successor-revision" }),
    ).then(() => {
      successorCreated = true;
      bindings.set(sessionKey, "successor-generation");
    });
    await Promise.resolve();
    expect(successorCreated).toBe(false);
    expect(bindings.get(sessionKey)).toBe("retired-generation");

    releaseFinalization();
    const [deleted] = await Promise.all([deletion, successor]);
    expect(deleted).toMatchObject({ ok: true, payload: { deleted: true } });
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      lifecycleRevision: "successor-revision",
      sessionId,
    });
    expect(bindings.get(sessionKey)).toBe("successor-generation");
  } finally {
    releaseFinalization();
    setActivePluginRegistry(previousRegistry ?? createEmptyPluginRegistry());
  }
});
