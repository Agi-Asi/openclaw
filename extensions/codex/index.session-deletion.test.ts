import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { expect, it, vi } from "vitest";
import plugin from "./index.js";
import {
  createCodexAppServerBindingStore,
  sessionBindingIdentity,
} from "./src/app-server/session-binding.js";
import { createCodexTestBindingStateStore } from "./src/app-server/session-binding.test-helpers.js";

function createCodexTestRuntime(stateStore = createCodexTestBindingStateStore()) {
  return {
    state: {
      openSyncKeyedStore: () => stateStore,
    },
  } as never;
}

it("finalizes only the exact deleted session binding under current plugin ownership", async () => {
  const stateStore = createCodexTestBindingStateStore();
  const bindingStore = createCodexAppServerBindingStore(stateStore);
  const onSessionDeleted = vi.fn();
  plugin.register(
    createTestPluginApi({
      id: "codex",
      name: "Codex",
      source: "test",
      config: {},
      pluginConfig: {},
      runtime: createCodexTestRuntime(stateStore),
      onSessionDeleted,
    }),
  );
  const registration = onSessionDeleted.mock.calls[0]?.[0] as
    | {
        agentHarnessId: string;
        handler: (
          event: { agentId: string; sessionId: string; sessionKey: string },
          context: { assertCurrent: () => void },
        ) => Promise<void>;
      }
    | undefined;
  if (!registration) {
    throw new Error("missing Codex session deletion finalizer");
  }
  expect(registration.agentHarnessId).toBe("codex");
  const finalize = registration.handler;
  const identity = sessionBindingIdentity({
    agentId: "worker",
    sessionId: "session-1",
    sessionKey: "agent:worker:deleted-session",
  });
  await bindingStore.mutate(identity, {
    kind: "set",
    binding: { threadId: "thread-deleted", cwd: "/repo" },
  });

  const assertCurrent = vi.fn();
  await finalize(
    {
      agentId: identity.agentId,
      sessionId: identity.sessionId,
      sessionKey: identity.sessionKey!,
    },
    { assertCurrent },
  );

  expect(assertCurrent).toHaveBeenCalled();
  expect(stateStore.entries()).toEqual([]);

  const staleIdentity = { ...identity, sessionId: "session-2" };
  await bindingStore.mutate(staleIdentity, {
    kind: "set",
    binding: { threadId: "thread-successor", cwd: "/repo" },
  });
  const staleAuthority = () => {
    throw new Error("plugin registration was replaced");
  };
  await expect(
    finalize(
      {
        agentId: staleIdentity.agentId,
        sessionId: staleIdentity.sessionId,
        sessionKey: staleIdentity.sessionKey!,
      },
      { assertCurrent: staleAuthority },
    ),
  ).rejects.toThrow("plugin registration was replaced");
  await expect(bindingStore.read(staleIdentity)).resolves.toMatchObject({
    threadId: "thread-successor",
  });

  const failed = {
    ...identity,
    sessionId: "session-failed",
    sessionKey: "agent:worker:failed-session",
  };
  await bindingStore.mutate(failed, {
    kind: "set",
    binding: { threadId: "thread-failed", cwd: "/repo" },
  });
  vi.spyOn(stateStore, "deleteIf").mockImplementationOnce(() => {
    throw new Error("conditional plugin cleanup failed");
  });
  await expect(
    finalize(
      {
        agentId: failed.agentId,
        sessionId: failed.sessionId,
        sessionKey: failed.sessionKey,
      },
      { assertCurrent },
    ),
  ).rejects.toThrow("conditional plugin cleanup failed");
  expect(stateStore.entries()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        value: expect.objectContaining({
          state: "cleared",
          retired: true,
          retirementReason: "deleted",
          sessionId: failed.sessionId,
        }),
      }),
    ]),
  );
  await expect(bindingStore.prepareSessionGenerationReclaim(failed)).resolves.toEqual({
    kind: "resolved",
    result: false,
  });

  const supervised = {
    ...identity,
    sessionId: "session-supervised",
    sessionKey: "agent:worker:supervised-session",
  };
  await bindingStore.mutate(supervised, {
    kind: "set",
    binding: {
      threadId: "native-private-thread",
      connectionScope: "supervision",
      supervisionSourceThreadId: "native-source-thread",
      cwd: "/repo",
      model: "gpt-5.6-luna",
      modelProvider: "openai",
      preserveNativeModel: true,
      conversationSourceTransferComplete: true,
    },
  });
  await expect(
    finalize(
      {
        agentId: supervised.agentId,
        sessionId: supervised.sessionId,
        sessionKey: supervised.sessionKey,
      },
      { assertCurrent },
    ),
  ).rejects.toThrow("conflicts with its binding owner");
  await expect(bindingStore.read(supervised)).resolves.toMatchObject({
    threadId: "native-private-thread",
    connectionScope: "supervision",
  });
});
