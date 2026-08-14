import { describe, expect, it, vi } from "vitest";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import { appendReplyDispatcherPayloadPrepare, createReplyDispatcher } from "./reply-dispatcher.js";

describe("reply dispatcher queue-time egress metadata", () => {
  it("does not call mocked final delivery when the queued authority is stale", async () => {
    const deliver = vi.fn(async () => undefined);
    const dispatcher = createReplyDispatcher({ deliver });
    let exposureRevision = 1;

    expect(
      appendReplyDispatcherPayloadPrepare(dispatcher, (payload, info) => {
        if (info.kind === "final") {
          setReplyPayloadMetadata(payload, {
            memoryEgressAuthorization: { exposureRevision } as never,
          });
        }
      }),
    ).toBe(true);
    dispatcher.appendBeforeDeliver?.((payload, info) =>
      info.kind !== "final" ||
      (
        getReplyPayloadMetadata(payload)?.memoryEgressAuthorization as unknown as {
          exposureRevision?: number;
        }
      )?.exposureRevision === exposureRevision
        ? payload
        : null,
    );

    expect(dispatcher.sendFinalReply({ text: "queued" })).toBe(true);
    exposureRevision = 2;
    await dispatcher.waitForIdle();

    expect(deliver).not.toHaveBeenCalled();
    expect(dispatcher.getCancelledCounts?.().final).toBe(1);
  });

  it("delivers a final whose queue-time authorization still matches", async () => {
    const deliver = vi.fn(async () => undefined);
    const dispatcher = createReplyDispatcher({ deliver });
    expect(
      appendReplyDispatcherPayloadPrepare(dispatcher, (payload, info) => {
        if (info.kind === "final") {
          setReplyPayloadMetadata(payload, {
            memoryEgressAuthorization: { exposureRevision: 1 } as never,
          });
        }
      }),
    ).toBe(true);
    dispatcher.appendBeforeDeliver?.((payload) => payload);

    dispatcher.sendFinalReply({ text: "current" });
    await dispatcher.waitForIdle();

    expect(deliver).toHaveBeenCalledOnce();
  });
});
