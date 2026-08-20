import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { WizardSession } from "../../wizard/session.js";
import { wizardHandlers } from "./wizard.js";

describe("locked wizard session lifecycle", () => {
  it.each(["wizard.cancel", "wizard.status"] as const)(
    "keeps the running session addressable after %s",
    async (method) => {
      const linked = createDeferred<string>();
      const session = new WizardSession(
        async (prompter, _signal, owner) => {
          owner.lockCancellation();
          await prompter.qrCode?.({
            title: "Link Signal",
            text: "sgnl://linkdevice?uuid=test",
            settled: linked.promise,
          });
        },
        { supportsQrCode: true },
      );
      const step = await session.next({ supportsQrCode: true });
      expect(step).toMatchObject({ done: false, step: { type: "qr", canCancel: false } });

      const wizardSessions = new Map([["locked", session]]);
      const context = {
        wizardSessions,
        purgeWizardSession: (sessionId: string) => wizardSessions.delete(sessionId),
      };
      const respond = vi.fn();
      await expectDefined(
        wizardHandlers[method],
        `${method} test invariant`,
      )({
        params: { sessionId: "locked" },
        respond,
        context,
      } as never);

      expect(respond).toHaveBeenCalledWith(
        true,
        { status: "running", error: undefined },
        undefined,
      );
      expect(wizardSessions.has("locked")).toBe(true);

      linked.resolve("linked");
      const terminalRespond = vi.fn();
      await expectDefined(
        wizardHandlers["wizard.next"],
        "wizard.next test invariant",
      )({
        params: { sessionId: "locked" },
        client: { connect: { caps: ["wizard-qr"] } },
        respond: terminalRespond,
        context,
      } as never);
      expect(terminalRespond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ done: true, status: "done" }),
        undefined,
      );
    },
  );
});
