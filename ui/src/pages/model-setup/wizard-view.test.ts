/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderModelSetupWizard } from "./wizard-view.ts";

describe("renderModelSetupWizard", () => {
  afterEach(() => {
    render(nothing, document.body);
    document.body.replaceChildren();
  });

  it("hides cancellation and keeps a locked QR dialog open", () => {
    const onCancel = vi.fn();
    render(
      renderModelSetupWizard({
        mode: "auth",
        state: {
          phase: "step",
          authChoice: "signal-link",
          step: {
            id: "signal-link",
            type: "qr",
            executor: "gateway",
            qrDataUrl: "data:image/png;base64,aGVsbG8=",
            canCancel: false,
          },
          busy: false,
          validationError: null,
        },
        refreshWarning: null,
        value: undefined,
        onValueChange: vi.fn(),
        onAnswer: vi.fn(),
        onCancel,
        onClose: vi.fn(),
      }),
      document.body,
    );
    const modal = document.body.querySelector("openclaw-modal-dialog");
    const dismissal = new CustomEvent("modal-cancel", { cancelable: true });

    modal?.dispatchEvent(dismissal);

    expect(dismissal.defaultPrevented).toBe(true);
    expect(document.body.querySelector(".wizard-step__actions button")).toBeNull();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
