import { randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { prepareWorktreeSessionTitle } from "../dashboard-session-title.js";
import { createGatewaySession } from "../session-create-service.js";
import { readSessionMessageCountAsync } from "../session-transcript-readers.js";
import { chatHandlers } from "./chat.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type { GatewayRequestHandlers } from "./types.js";

type ChatSendRequest = Parameters<NonNullable<GatewayRequestHandlers["chat.send"]>>[0];
type CreatedSession = Parameters<
  NonNullable<Parameters<typeof createGatewaySession>[0]["afterCreate"]>
>[0];

type InitialDispatchResult = {
  messageSeq?: number;
  runError?: unknown;
  runMeta?: Record<string, unknown>;
  runPayload?: Record<string, unknown>;
};

export function createSessionInitialDispatch(params: {
  active: () => boolean;
  attachments?: ChatSendRequest["params"]["attachments"];
  client: ChatSendRequest["client"];
  context: ChatSendRequest["context"];
  enabled: boolean;
  isWebchatConnect: ChatSendRequest["isWebchatConnect"];
  message?: string;
  req: ChatSendRequest["req"];
  worktreeTitle: () => ReturnType<typeof prepareWorktreeSessionTitle>;
}) {
  const result: InitialDispatchResult = {};
  const afterCreate = async ({ key, agentId, entry, storePath }: CreatedSession) => {
    if (!params.active()) {
      return;
    }
    if (
      await params.worktreeTitle()?.persist(agentId, entry, key, storePath, () => {
        if (!params.active()) {
          throw new Error("session creation authority is no longer active");
        }
      })
    ) {
      emitSessionsChanged(params.context, { sessionKey: key, agentId, reason: "chat.title" });
    }
    if (!params.enabled || !params.active()) {
      return;
    }
    result.messageSeq =
      (await readSessionMessageCountAsync({
        agentId,
        sessionEntry: entry,
        sessionId: entry.sessionId,
        sessionKey: key,
        storePath,
      })) + 1;
    await expectDefined(
      chatHandlers["chat.send"],
      "chat.send handler",
    )({
      req: params.req,
      params: {
        sessionKey: key,
        agentId,
        message: params.message ?? "",
        idempotencyKey: randomUUID(),
        ...(params.attachments ? { attachments: params.attachments } : {}),
      },
      respond: (ok, payload, error, meta) => {
        if (ok && isRecord(payload)) {
          result.runPayload = payload;
        } else {
          result.runError = error;
        }
        result.runMeta = meta;
      },
      context: params.context,
      client: params.client,
      isWebchatConnect: params.isWebchatConnect,
    });
  };
  return { afterCreate, result };
}
