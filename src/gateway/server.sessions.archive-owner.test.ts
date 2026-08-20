import { expect, test, vi } from "vitest";
import { registerChatAbortController } from "./chat-abort.js";
import { createChatRunState } from "./server-chat-state.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

test("archiving a non-default agent ignores the ambient owner's ownerless run", async () => {
  const { storePath } = await createSessionStoreDir();
  const cfg = {
    agents: {
      ownership: "explicit" as const,
      defaults: { systemAgent: { agentId: "ops" } },
      entries: { ops: {}, research: {} },
    },
    session: { store: storePath },
  };
  const sessionKey = "agent:research:archive-owner-scope";
  const sessionId = "session-archive-owner-scope";
  await writeSessionStore({
    agentId: "research",
    entries: { [sessionKey]: sessionStoreEntry(sessionId) },
    storePath,
  });

  const chatAbortControllers = new Map();
  const compatibilityRun = registerChatAbortController({
    chatAbortControllers,
    runId: "run-ops-ownerless",
    sessionId,
    sessionKey: "legacy-unscoped",
    timeoutMs: 60_000,
  });

  const archived = await directSessionReq(
    "sessions.patch",
    { key: sessionKey, archived: true, expectedSessionId: sessionId },
    {
      context: {
        agentRunSeq: new Map(),
        broadcast: vi.fn(),
        cancelRunBoundApprovals: vi.fn(),
        chatAbortControllers,
        chatRunState: createChatRunState(),
        getRuntimeConfig: () => cfg,
        nodeSendToSession: vi.fn(),
        removeChatRun: vi.fn(),
      },
    },
  );

  expect(archived.ok, JSON.stringify(archived)).toBe(true);
  expect(compatibilityRun.controller.signal.aborted).toBe(false);
});
