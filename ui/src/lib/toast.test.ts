/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import "../components/modal-dialog.ts";
import { showToast } from "./toast.ts";

type ToastVariant = NonNullable<Parameters<typeof showToast>[0]["variant"]>;

async function mountGlobalHost() {
  const host = document.createElement("openclaw-toast-host");
  document.body.append(host);
  await host.updateComplete;
  return host;
}

async function mountSessionHost(sessionKey = "agent:main:main") {
  const host = document.createElement("openclaw-session-toast-host");
  host.sessionKey = sessionKey;
  host.presented = true;
  host.active = true;
  document.body.append(host);
  await host.updateComplete;
  return host;
}

function present(message: string, key = message, variant: ToastVariant = "info") {
  return showToast({ key, message, variant });
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("shared toast", () => {
  it("keeps the newest three independent outcomes", async () => {
    const host = await mountGlobalHost();

    for (const message of ["First", "Second", "Third", "Fourth"]) {
      present(message);
    }
    await host.updateComplete;

    expect(
      [...host.querySelectorAll(".app-toast__message")].map((element) => element.textContent),
    ).toEqual(["Second", "Third", "Fourth"]);
  });

  it("replaces an outcome with the same key without growing the stack", async () => {
    const host = await mountGlobalHost();
    const reasons: string[] = [];

    showToast({
      key: "connection",
      message: "Connecting",
      onDismiss: (reason) => reasons.push(reason),
      variant: "info",
    });
    showToast({ key: "connection", message: "Connected", variant: "success" });
    await host.updateComplete;

    expect(host.querySelectorAll(".app-toast")).toHaveLength(1);
    expect(host.querySelector(".app-toast__message")?.textContent).toBe("Connected");
    expect(reasons).toEqual(["replaced"]);
  });

  it.each([
    ["info", "status", "polite"],
    ["success", "status", "polite"],
    ["warning", "alert", "assertive"],
    ["danger", "alert", "assertive"],
  ] as const)("uses the accessibility contract for %s", async (variant, role, live) => {
    const host = await mountGlobalHost();

    present(variant, variant, variant);
    await host.updateComplete;

    const toast = host.querySelector(`.app-toast--${variant}`);
    expect(toast?.getAttribute("role")).toBe(role);
    expect(toast?.getAttribute("aria-live")).toBe(live);
  });

  it("routes a visible session outcome to its compact pane host", async () => {
    const globalHost = await mountGlobalHost();
    const sessionHost = await mountSessionHost();

    showToast({
      key: "copy-image",
      message: "Copied",
      scope: { kind: "session", sessionKey: "main" },
      variant: "success",
    });
    await sessionHost.updateComplete;

    expect(sessionHost.querySelector(".app-toast--session")?.textContent).toContain("Copied");
    expect(globalHost.querySelector(".app-toast")).toBeNull();
  });

  it("falls back to the global host when the owning session is not presented", async () => {
    const globalHost = await mountGlobalHost();
    const sessionHost = await mountSessionHost("agent:main:other");

    showToast({
      key: "copy-image",
      message: "Copied",
      scope: { kind: "session", sessionKey: "agent:main:main" },
      variant: "success",
    });
    await globalHost.updateComplete;

    expect(globalHost.querySelector(".app-toast--global")?.textContent).toContain("Copied");
    expect(sessionHost.querySelector(".app-toast")).toBeNull();
  });

  it("moves an active chip to the global host when its pane is hidden", async () => {
    const globalHost = await mountGlobalHost();
    const sessionHost = await mountSessionHost();

    showToast({
      key: "copy-image",
      message: "Copied",
      scope: { kind: "session", sessionKey: "agent:main:main" },
      variant: "success",
    });
    await sessionHost.updateComplete;
    sessionHost.presented = false;
    await sessionHost.updateComplete;
    await globalHost.updateComplete;

    expect(sessionHost.querySelector(".app-toast")).toBeNull();
    expect(globalHost.querySelector(".app-toast--global")?.textContent).toContain("Copied");
  });

  it("uses the active modal's toast layer before the app layer", async () => {
    const appHost = await mountGlobalHost();
    const modal = document.createElement("openclaw-modal-dialog");
    modal.open = true;
    document.body.append(modal);
    await modal.updateComplete;
    const moveBefore = vi.spyOn(Element.prototype, "moveBefore");

    present("Above overlay");
    await appHost.updateComplete;

    expect(moveBefore).toHaveBeenCalledWith(appHost, null);
    expect(moveBefore.mock.contexts).toContain(modal);
    expect(appHost.textContent).toContain("Above overlay");
  });

  it("routes through an active modal inside a shadow root", async () => {
    const appHost = await mountGlobalHost();
    const shadowOwner = document.createElement("div");
    const shadowRoot = shadowOwner.attachShadow({ mode: "open" });
    const modal = document.createElement("openclaw-modal-dialog");
    modal.open = true;
    shadowRoot.append(modal);
    document.body.append(shadowOwner);
    await modal.updateComplete;
    const moveBefore = vi.spyOn(Element.prototype, "moveBefore");

    present("Critical session notice", "critical", "danger");
    await appHost.updateComplete;

    expect(moveBefore).toHaveBeenCalledWith(appHost, null);
    expect(moveBefore.mock.contexts).toContain(modal);
    expect(appHost.textContent).toContain("Critical session notice");
  });

  it("auto-dismisses after the configured duration and exit transition", async () => {
    vi.useFakeTimers();
    const host = await mountGlobalHost();

    showToast({ key: "temporary", message: "Temporary", durationMs: 50, variant: "info" });
    await host.updateComplete;
    await vi.advanceTimersByTimeAsync(50);
    await host.updateComplete;

    expect(host.querySelector(".app-toast")?.getAttribute("data-state")).toBe("exiting");
    await vi.advanceTimersByTimeAsync(150);
    await host.updateComplete;
    expect(host.querySelector(".app-toast")).toBeNull();
  });

  it("runs its action once and reports dismissal reasons", async () => {
    vi.useFakeTimers();
    const host = await mountGlobalHost();
    const reasons: string[] = [];
    const onAction = vi.fn();
    showToast({
      key: "archived",
      message: "Archived",
      actionLabel: "Undo",
      onAction,
      onDismiss: (reason) => reasons.push(reason),
      variant: "success",
    });
    await host.updateComplete;

    host.querySelector<HTMLButtonElement>(".app-toast__action")?.click();
    await vi.advanceTimersByTimeAsync(150);
    await host.updateComplete;

    expect(onAction).toHaveBeenCalledOnce();
    expect(reasons).toEqual(["action"]);
    expect(host.querySelector(".app-toast")).toBeNull();
  });

  it("reports when no host can present the toast", () => {
    expect(present("Unavailable")).toBe(false);
  });
});
