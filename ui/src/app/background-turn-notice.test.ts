/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { showBackgroundTurnNotice } from "./background-turn-notice.runtime.ts";

afterEach(() => {
  document.body.replaceChildren();
});

describe("background turn notice", () => {
  it("does not announce a session that is already selected", async () => {
    const toastHost = document.createElement("openclaw-toast-host");
    document.body.append(toastHost);

    showBackgroundTurnNotice({
      outcome: {
        key: "agent:main:selected",
        runId: "run-selected",
        status: "completed",
      },
      selectedSessionKey: "agent:main:selected",
      sessionHost: {},
      sessions: [],
      onOpen: vi.fn(),
    });

    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast")).toBeNull();
  });

  it("queues concurrent outcomes and opens their exact sessions in order", async () => {
    const toastHost = document.createElement("openclaw-toast-host");
    document.body.append(toastHost);
    const onOpen = vi.fn();
    const show = (key: string, runId: string) =>
      showBackgroundTurnNotice({
        outcome: { key, runId, status: "completed" },
        selectedSessionKey: "agent:main:selected",
        sessionHost: {},
        sessions: [
          { key: "agent:main:first", label: "First task", kind: "direct", updatedAt: null },
          { key: "agent:main:second", label: "Second task", kind: "direct", updatedAt: null },
        ],
        onOpen,
      });

    show("agent:main:first", "run-first");
    show("agent:main:second", "run-second");
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast__message")?.textContent).toContain("First task");

    toastHost.querySelector<HTMLButtonElement>(".app-toast__action")?.click();
    await toastHost.updateComplete;
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("agent:main:first", undefined);
    expect(toastHost.querySelector(".app-toast__message")?.textContent).toContain("Second task");
  });
});
