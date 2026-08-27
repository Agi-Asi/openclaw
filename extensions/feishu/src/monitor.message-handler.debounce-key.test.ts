// Regression tests for Feishu inbound debounce key construction.
// Covers #130028: distinct topic threads with no root_id were aliased to the
// same "chat" debounce bucket when thread_id was present but root_id was absent.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNonExitingRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import * as dedup from "./dedup.js";
import type { FeishuMessageEvent } from "./event-types.js";
import { createFeishuMessageReceiveHandler } from "./monitor.message-handler.js";

type CreateInboundDebouncerOptions = Parameters<
  PluginRuntime["channel"]["debounce"]["createInboundDebouncer"]
>[0];

function makeTextEvent(
  overrides: Partial<FeishuMessageEvent["message"]> & {
    open_id?: string;
  } = {},
): FeishuMessageEvent {
  const { open_id = "ou-user", ...messageOverrides } = overrides;
  return {
    sender: {
      sender_id: { open_id },
      sender_type: "user",
    },
    message: {
      message_id: "msg-001",
      chat_id: "oc-shared-chat",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text: "hello" }),
      create_time: "1710000000000",
      ...messageOverrides,
    },
  };
}

function captureDebounceKey(event: FeishuMessageEvent): string | null {
  let capturedBuildKey:
    | ((args: { event: FeishuMessageEvent }) => string | null)
    | undefined;

  const channelRuntime = {
    commands: { isControlCommandMessage: () => false },
    debounce: {
      resolveInboundDebounceMs: () => 25,
      createInboundDebouncer: vi.fn(
        (options: CreateInboundDebouncerOptions) => {
          capturedBuildKey = options.buildKey as (args: {
            event: FeishuMessageEvent;
          }) => string | null;
          return {
            enqueue: vi.fn(async () => {}),
            flushKey: vi.fn(async () => {}),
            cancelKey: vi.fn(() => false),
            drain: vi.fn(async () => {}),
          };
        },
      ),
    },
  } as unknown as PluginRuntime["channel"];

  vi.spyOn(dedup, "claimUnprocessedFeishuMessage").mockResolvedValue({
    kind: "already-processed",
  });

  createFeishuMessageReceiveHandler({
    cfg: {} as ClawdbotConfig,
    channelRuntime,
    accountId: "default",
    runtime: createNonExitingRuntimeEnv(),
    chatHistories: new Map(),
    handleMessage: vi.fn(async () => {}),
    resolveDebounceText: () => "hello",
    hasProcessedMessage: vi.fn(async () => false),
    getBotOpenId: () => "ou-bot",
    resolveIngressLifecycle: () => undefined,
  });

  if (!capturedBuildKey) {
    throw new Error("createInboundDebouncer was not called during handler construction");
  }

  return capturedBuildKey({ event });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Feishu inbound debounce key construction", () => {
  it("uses root_id as the thread key when root_id is present", () => {
    const event = makeTextEvent({ root_id: "om_root_001", thread_id: "omt_thread_001" });
    const key = captureDebounceKey(event);
    expect(key).toBe("feishu:default:oc-shared-chat:thread:om_root_001:ou-user");
  });

  it("uses thread_id as the thread key when root_id is absent but thread_id is present", () => {
    // Regression for #130028: two events with different thread_id values but no
    // root_id must produce different keys, not both collapse to ":chat:".
    const eventA = makeTextEvent({ thread_id: "omt-topic-a" });
    const eventB = makeTextEvent({ thread_id: "omt-topic-b" });
    const keyA = captureDebounceKey(eventA);
    const keyB = captureDebounceKey(eventB);
    expect(keyA).toBe("feishu:default:oc-shared-chat:thread:omt-topic-a:ou-user");
    expect(keyB).toBe("feishu:default:oc-shared-chat:thread:omt-topic-b:ou-user");
    expect(keyA).not.toBe(keyB);
  });

  it("falls back to 'chat' when both root_id and thread_id are absent", () => {
    const event = makeTextEvent({});
    const key = captureDebounceKey(event);
    expect(key).toBe("feishu:default:oc-shared-chat:chat:ou-user");
  });

  it("returns null when chat_id is absent", () => {
    const event = makeTextEvent({ chat_id: "" as string });
    // Override chat_id to empty to trigger null path
    (event.message as { chat_id: string }).chat_id = "";
    const key = captureDebounceKey(event);
    expect(key).toBeNull();
  });

  it("returns null when sender open_id and user_id are both absent", () => {
    const event = makeTextEvent({});
    (event.sender.sender_id as { open_id?: string }).open_id = undefined;
    const key = captureDebounceKey(event);
    expect(key).toBeNull();
  });

  it("two events with the same thread_id (no root_id) share one debounce bucket", () => {
    const eventA = makeTextEvent({ thread_id: "omt-shared-topic" });
    const eventB = makeTextEvent({ thread_id: "omt-shared-topic" });
    const keyA = captureDebounceKey(eventA);
    const keyB = captureDebounceKey(eventB);
    expect(keyA).toBe(keyB);
  });
});
