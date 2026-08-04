// E2E boundary coverage for Slack routing through reply-session initialization.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedSlackAccount } from "../../../../extensions/slack/src/accounts.js";
import { resolveSlackRoutingContext } from "../../../../extensions/slack/src/monitor/message-handler/prepare-routing.js";
import type { SlackMessageEvent } from "../../../../extensions/slack/src/types.js";
import { initSessionState } from "../../../../src/auto-reply/reply/test/session.test-support.js";
import type { OpenClawConfig } from "../../../../src/config/config.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../../../src/config/sessions/session-accessor.js";
import { closeOpenClawStateDatabaseForTest } from "../../../../src/state/openclaw-state-db.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-slack-parent-fork-e2e-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await closeOpenClawStateDatabaseForTest();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function buildSlackAccount(): ResolvedSlackAccount {
  return {
    accountId: "default",
    enabled: true,
    identity: "bot",
    botTokenSource: "config",
    appTokenSource: "config",
    userTokenSource: "none",
    config: { replyToMode: "all" },
    replyToMode: "all",
  };
}

function buildSlackMessage(overrides: Partial<SlackMessageEvent>): SlackMessageEvent {
  return {
    channel: "C123",
    channel_type: "channel",
    user: "U1",
    text: "hello",
    ts: "1770408518.451689",
    ...overrides,
  } as SlackMessageEvent;
}

function readMessageContents(events: unknown[]): string[] {
  return events.flatMap((event) => {
    if (!event || typeof event !== "object") {
      return [];
    }
    const record = event as Record<string, unknown>;
    if (record.type !== "message" || !record.message || typeof record.message !== "object") {
      return [];
    }
    const content =
      "content" in record.message ? (record.message as Record<string, unknown>).content : undefined;
    return typeof content === "string" ? [content] : [];
  });
}

describe("Slack bot-opened thread parent inheritance E2E", () => {
  it.each([
    { label: "unset upgrade default", inheritParent: undefined, expectParent: true },
    { label: "explicit false", inheritParent: false, expectParent: false },
    { label: "explicit true", inheritParent: true, expectParent: true },
  ])(
    "routes, forks, and reuses the thread session for $label",
    async ({ inheritParent, expectParent }) => {
      const root = makeRoot();
      const storePath = path.join(root, "sessions.json");
      const cfg = {
        session: { store: storePath },
        channels: { slack: { enabled: true, replyToMode: "all" } },
      } as OpenClawConfig;
      const routingCtx = {
        cfg,
        teamId: "T1",
        threadHistoryScope: "thread" as const,
        threadInheritParent: inheritParent,
      };
      const account = buildSlackAccount();
      const rootTs = "1770408518.451689";
      const parentSessionKey = "agent:main:slack:channel:c123";
      const parentSessionId = `parent-${String(inheritParent)}`;
      const parentMarker = `PARENT_MARKER_${String(inheritParent).toUpperCase()}`;

      await replaceSessionEntry(
        { agentId: "main", sessionKey: parentSessionKey, storePath },
        {
          sessionId: parentSessionId,
          totalTokens: 12,
          totalTokensFresh: true,
          updatedAt: Date.now(),
        },
      );
      await appendTranscriptMessage(
        { agentId: "main", sessionId: parentSessionId, sessionKey: parentSessionKey, storePath },
        { message: { role: "user", content: parentMarker } },
      );
      await appendTranscriptMessage(
        { agentId: "main", sessionId: parentSessionId, sessionKey: parentSessionKey, storePath },
        { message: { role: "assistant", content: "parent acknowledged" } },
      );
      expect(
        readMessageContents(
          await loadTranscriptEvents({
            agentId: "main",
            sessionId: parentSessionId,
            sessionKey: parentSessionKey,
            storePath,
          }),
        ),
      ).toContain(parentMarker);

      const openedRoot = resolveSlackRoutingContext({
        ctx: routingCtx,
        account,
        message: buildSlackMessage({ text: "<@B1> continue the channel discussion", ts: rootTs }),
        isDirectMessage: false,
        isGroupDm: false,
        isRoom: true,
        isRoomish: true,
        seedTopLevelRoomThread: true,
      });
      const followUp = resolveSlackRoutingContext({
        ctx: routingCtx,
        account,
        message: buildSlackMessage({
          text: "continue",
          ts: "1770408522.168859",
          thread_ts: rootTs,
          parent_user_id: "B1",
        }),
        isDirectMessage: false,
        isGroupDm: false,
        isRoom: true,
        isRoomish: true,
      });

      expect(openedRoot.threadKeys.parentSessionKey).toBe(
        expectParent ? parentSessionKey : undefined,
      );
      expect(followUp.sessionKey).toBe(openedRoot.sessionKey);
      expect(followUp.threadKeys.parentSessionKey).toBe(
        inheritParent === true ? parentSessionKey : undefined,
      );

      const first = await initSessionState({
        ctx: {
          Body: "continue the channel discussion",
          SessionKey: openedRoot.sessionKey,
          ParentSessionKey: openedRoot.threadKeys.parentSessionKey,
        },
        cfg,
      });
      expect(first.sessionEntry.forkSource).toEqual(
        expectParent ? { sessionKey: parentSessionKey, sessionId: parentSessionId } : undefined,
      );
      const childMarker = `CHILD_MARKER_${String(inheritParent).toUpperCase()}`;
      await appendTranscriptMessage(
        {
          agentId: "main",
          sessionId: first.sessionEntry.sessionId,
          sessionKey: openedRoot.sessionKey,
          storePath,
        },
        { message: { role: "assistant", content: childMarker } },
      );

      const second = await initSessionState({
        ctx: {
          Body: "continue",
          SessionKey: followUp.sessionKey,
          ParentSessionKey: followUp.threadKeys.parentSessionKey,
        },
        cfg,
      });
      expect(second.sessionEntry.sessionId).toBe(first.sessionEntry.sessionId);
      expect(second.sessionEntry.forkedFromParent).toBe(expectParent ? true : undefined);

      const contents = readMessageContents(
        await loadTranscriptEvents({
          agentId: "main",
          sessionId: second.sessionEntry.sessionId,
          sessionKey: followUp.sessionKey,
          storePath,
        }),
      );
      expect(contents).toContain(childMarker);
      if (expectParent) {
        expect(contents).toContain(parentMarker);
        expect(second.sessionEntry.forkSource).toEqual({
          sessionKey: parentSessionKey,
          sessionId: parentSessionId,
        });
      } else {
        expect(contents).not.toContain(parentMarker);
        expect(second.sessionEntry.forkSource).toBeUndefined();
      }
    },
  );
});
