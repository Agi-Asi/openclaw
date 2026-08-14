import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { createDispatcher, emptyConfig } from "./dispatch-from-config.shared.test-harness.js";
import {
  dispatchReplyFromConfig,
  describe0BeforeEach0,
  globalBeforeAll0,
  setNoAbort,
} from "./dispatch-from-config.test-harness.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

const memoryCutover = vi.hoisted(() => ({ enabled: false }));

vi.mock("../../plugins/memory-cutover.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/memory-cutover.js")>()),
  isMemoryIsolationCutoverAgent: () => memoryCutover.enabled,
}));

beforeAll(globalBeforeAll0);

describe("memory egress progress confinement", () => {
  beforeEach(describe0BeforeEach0);

  it("omits every channel-visible progress callback for a cutover run while retaining final delivery", async () => {
    setNoAbort();
    memoryCutover.enabled = true;
    const finalDelivery = vi.fn(async () => undefined);
    const dispatcher = createReplyDispatcher({ deliver: finalDelivery });
    const replyResolver = vi.fn(async (_ctx: MsgContext, options?: GetReplyOptions) => {
      expect(options).toEqual(
        expect.objectContaining({
          onPartialReply: undefined,
          onReasoningStream: undefined,
          onReasoningProgress: undefined,
          onReasoningEnd: undefined,
          onAssistantMessageStart: undefined,
          onBlockReplyQueued: undefined,
          onBlockReply: undefined,
          onToolStart: undefined,
          onToolResult: undefined,
          onItemEvent: undefined,
          onNarrationUpdate: undefined,
          onProgressNarratorLifecycle: undefined,
          onPlanUpdate: undefined,
          onApprovalEvent: undefined,
          onCommandOutput: undefined,
          onPatchSummary: undefined,
          onCompactionStart: undefined,
          onCompactionEnd: undefined,
          commentaryProgressEnabled: false,
          reasoningPayloadsEnabled: false,
          commentaryPayloadsEnabled: false,
        }),
      );
      return { text: "admitted final" } satisfies ReplyPayload;
    });

    try {
      const result = await dispatchReplyFromConfig({
        ctx: buildTestCtx({
          AgentId: "memory-agent",
          SessionKey: "agent:memory-agent:direct:alice",
        }),
        cfg: emptyConfig,
        dispatcher,
        replyOptions: {
          onPartialReply: vi.fn(),
          onReasoningStream: vi.fn(),
          onBlockReplyQueued: vi.fn(),
          onToolResult: vi.fn(),
          onItemEvent: vi.fn(),
          onNarrationUpdate: vi.fn(),
          onProgressNarratorLifecycle: vi.fn(),
          onPlanUpdate: vi.fn(),
          onApprovalEvent: vi.fn(),
          onCommandOutput: vi.fn(),
          onPatchSummary: vi.fn(),
          onCompactionStart: vi.fn(),
          onCompactionEnd: vi.fn(),
        },
        replyResolver,
      });

      await dispatcher.waitForIdle();
      expect(result).toMatchObject({ queuedFinal: true, counts: { final: 1 } });
      expect(finalDelivery).toHaveBeenCalledOnce();
    } finally {
      memoryCutover.enabled = false;
    }
  });

  it("keeps progress callbacks available outside cutover", async () => {
    setNoAbort();
    const onPartialReply = vi.fn();
    const replyResolver = vi.fn(async (_ctx: MsgContext, options?: GetReplyOptions) => {
      expect(options?.onPartialReply).toBeTypeOf("function");
      return { text: "ordinary final" } satisfies ReplyPayload;
    });

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        AgentId: "ordinary-agent",
        SessionKey: "agent:ordinary-agent:direct:alice",
      }),
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      replyOptions: { onPartialReply },
      replyResolver,
    });
  });
});
