/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GatewayBrowserClient,
  GatewayBrowserClientOptions,
  GatewayHelloOk,
} from "../api/gateway.ts";
import { createApplicationRouter } from "../app-routes.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import "./app-host.ts";
import type { ApplicationRuntime } from "./bootstrap.ts";
import type { ApplicationContext, ApplicationGateway } from "./context.ts";
import { createApplicationGateway } from "./gateway-store.ts";
import { loadSettings } from "./settings.ts";

const HELLO: GatewayHelloOk = {
  type: "hello-ok",
  protocol: 1,
  auth: { role: "operator", scopes: [] },
};

function createGatewayHarness() {
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
  const clients: Array<{ opts: GatewayBrowserClientOptions }> = [];
  const gateway = createApplicationGateway(loadSettings(), "", "", (opts) => {
    const client = {
      opts,
      instanceId: opts.instanceId,
      start: vi.fn(),
      stop: vi.fn(),
      request: vi.fn(),
    };
    clients.push(client);
    return client as unknown as GatewayBrowserClient;
  });
  return { gateway, clients };
}

function renderGatewaySurface(
  gateway: ApplicationGateway,
  documentView?: "desktop" | "terminal",
): string {
  const originalUrl = `${location.pathname}${location.search}${location.hash}`;
  if (documentView) {
    history.replaceState({}, "", `?view=${documentView}`);
  }
  try {
    const app = document.createElement("openclaw-app") as unknown as {
      runtime: Pick<ApplicationRuntime, "context" | "documentMode" | "router">;
      render: () => { strings: readonly string[] };
      synchronizeGateway: (gateway: ApplicationGateway) => void;
    };
    app.runtime = {
      documentMode: null,
      router: createApplicationRouter(),
      context: {
        gateway,
        basePath: "",
        agentSelection: { state: { selectedId: null } },
        config: { current: { terminalEnabled: false } },
        theme: { resolvedMode: "dark" },
      } as unknown as ApplicationContext,
    };
    app.synchronizeGateway(gateway);
    const container = document.createElement("div");
    render(app.render(), container);
    return container.innerHTML;
  } finally {
    history.replaceState({}, "", originalUrl);
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Control UI Gateway target lineage", () => {
  it("restarts the splash delay per Gateway generation and fences stale timers", async () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const timerCallback = (index: number) => {
      const callback = timeoutSpy.mock.calls.filter(([, delay]) => delay === 300)[index]?.[0];
      if (typeof callback !== "function") {
        throw new Error(`missing splash timer ${index}`);
      }
      return callback;
    };
    const { gateway, clients } = createGatewayHarness();
    expect(renderGatewaySurface(gateway)).toContain("<openclaw-login-gate");
    gateway.start();
    const app = document.createElement("openclaw-app") as unknown as {
      runtime: Pick<ApplicationRuntime, "context" | "documentMode" | "router" | "stop">;
      render: () => { strings: readonly string[] };
      requestUpdate: () => void;
      synchronizeGateway: (gateway: ApplicationGateway) => void;
      disconnectedCallback: () => void;
    };
    app.runtime = {
      documentMode: null,
      router: createApplicationRouter(),
      stop: vi.fn(),
      context: {
        gateway,
        basePath: "",
        agentSelection: { state: { selectedId: null } },
        config: { current: { terminalEnabled: false } },
        theme: { resolvedMode: "dark" },
      } as unknown as ApplicationContext,
    };
    app.synchronizeGateway(gateway);
    await vi.advanceTimersByTimeAsync(299);

    gateway.connect({ gatewayUrl: "wss://other-gateway.example.test" });
    app.synchronizeGateway(gateway);
    timerCallback(0)();
    await vi.advanceTimersByTimeAsync(1);
    const container = document.createElement("div");
    render(app.render(), container);
    expect(container.innerHTML).toContain('class="shell"');
    expect(container.innerHTML).not.toContain('class="connect-splash"');

    await vi.advanceTimersByTimeAsync(299);
    render(app.render(), container);
    expect(container.innerHTML).toContain('class="connect-splash"');

    clients[1]?.opts.onClose?.({ code: 1006, reason: "remote refused", willRetry: true });
    app.synchronizeGateway(gateway);
    render(app.render(), container);
    const surface = container.innerHTML;

    expect(surface).toContain("<openclaw-login-gate");
    expect(surface).not.toContain("<openclaw-app-shell");

    gateway.connect({ gatewayUrl: "wss://third-gateway.example.test" });
    app.synchronizeGateway(gateway);
    const disposedTimer = timerCallback(2);
    const requestUpdate = vi.spyOn(app, "requestUpdate");
    app.disconnectedCallback();
    requestUpdate.mockClear();
    disposedTimer();
    expect(requestUpdate).not.toHaveBeenCalled();
  });

  it("keeps retryable Gateway startup on the initial progress surface", () => {
    const { gateway, clients } = createGatewayHarness();
    gateway.start();
    clients[0]?.opts.onClose?.({
      code: 4013,
      reason: "gateway starting",
      willRetry: true,
      error: {
        code: "UNAVAILABLE",
        message: "gateway starting; retry shortly",
        details: { reason: "startup-sidecars" },
        retryable: true,
        retryAfterMs: 250,
      },
    });

    const surface = renderGatewaySurface(gateway);

    expect(gateway.snapshot.phase).toBe("starting");
    expect(surface).toContain('class="connect-splash"');
    expect(surface).toContain("Gateway starting…");
    expect(surface).not.toContain("<openclaw-login-gate");
  });

  it("rearms startup progress after a manual connection attempt", async () => {
    vi.useFakeTimers();
    const { gateway, clients } = createGatewayHarness();
    gateway.start();
    clients[0]?.opts.onClose?.({
      code: 1006,
      reason: "manual connection required",
      willRetry: true,
    });
    const app = document.createElement("openclaw-app") as unknown as {
      runtime: Pick<ApplicationRuntime, "context" | "documentMode" | "router">;
      render: () => { strings: readonly string[] };
      synchronizeGateway: (gateway: ApplicationGateway) => void;
    };
    app.runtime = {
      documentMode: null,
      router: createApplicationRouter(),
      context: {
        gateway,
        basePath: "",
        agentSelection: { state: { selectedId: null } },
        config: { current: { terminalEnabled: false } },
        theme: { resolvedMode: "dark" },
      } as unknown as ApplicationContext,
    };
    app.synchronizeGateway(gateway);
    const container = document.createElement("div");
    render(app.render(), container);
    const loginGate = container.querySelector("openclaw-login-gate") as unknown as {
      props: { onConnect: () => void };
    };

    loginGate.props.onConnect();
    app.synchronizeGateway(gateway);
    await vi.advanceTimersByTimeAsync(299);
    clients[1]?.opts.onClose?.({
      code: 4013,
      reason: "gateway starting",
      willRetry: true,
      error: {
        code: "UNAVAILABLE",
        message: "gateway starting; retry shortly",
        details: { reason: "startup-sidecars" },
        retryable: true,
        retryAfterMs: 250,
      },
    });
    app.synchronizeGateway(gateway);
    render(app.render(), container);

    expect(container.innerHTML).toContain("Gateway starting…");
    expect(container.innerHTML).not.toContain("<openclaw-login-gate");

    clients[1]?.opts.onHello?.(HELLO);
    render(app.render(), container);
    expect(container.innerHTML).toContain("<openclaw-app-shell");
  });

  it.each(["desktop", "terminal"] as const)(
    "shows retryable Gateway startup in the standalone %s document",
    (documentView) => {
      const { gateway, clients } = createGatewayHarness();
      gateway.start();
      clients[0]?.opts.onClose?.({
        code: 4013,
        reason: "gateway starting",
        willRetry: true,
        error: {
          code: "UNAVAILABLE",
          message: "gateway starting; retry shortly",
          details: { reason: "startup-sidecars" },
          retryable: true,
          retryAfterMs: 250,
        },
      });

      const surface = renderGatewaySurface(gateway, documentView);

      expect(surface).toContain('class="connect-splash"');
      expect(surface).toContain("Gateway starting…");
    },
  );

  it("keeps an established Gateway's dashboard mounted during its own retry", () => {
    const { gateway, clients } = createGatewayHarness();
    gateway.start();
    clients[0]?.opts.onHello?.(HELLO);
    clients[0]?.opts.onClose?.({ code: 1006, reason: "same gateway blip", willRetry: true });

    const surface = renderGatewaySurface(gateway);

    expect(surface).toContain("<openclaw-app-shell");
    expect(surface).not.toContain("<openclaw-login-gate");
  });

  it("retains a replacement Gateway's dashboard after its own successful hello", () => {
    const { gateway, clients } = createGatewayHarness();
    gateway.start();
    clients[0]?.opts.onHello?.(HELLO);
    gateway.connect({ gatewayUrl: "wss://other-gateway.example.test" });
    clients[1]?.opts.onHello?.(HELLO);
    clients[1]?.opts.onClose?.({ code: 1006, reason: "replacement blip", willRetry: true });

    const surface = renderGatewaySurface(gateway);

    expect(surface).toContain("<openclaw-app-shell");
    expect(surface).not.toContain("<openclaw-login-gate");
  });
});
