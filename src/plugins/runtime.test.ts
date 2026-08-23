/** Covers plugin runtime registration API behavior and registry mutation guards. */
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { createPluginMetadataSnapshot } from "../config/plugin-auto-enable.test-helpers.js";
import { getPluginRunContext, setPluginRunContext } from "./host-hook-runtime.js";
import type { PluginSessionDeletionFinalizer } from "./plugin-api.types.js";
import {
  activatePluginRecordLifecycleEpoch,
  revokePluginRecordLifecycleEpoch,
} from "./registry-lifecycle.js";
import { createEmptyPluginRegistry } from "./registry.js";
import type { PluginHttpRouteRegistration } from "./registry.js";
import {
  clearActivePluginRegistry,
  commitStagedPluginRegistry,
  getActivePluginRegistry,
  listImportedRuntimePluginIds,
  recordImportedPluginId,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
  stageActivePluginRegistry,
} from "./runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { withPluginRuntimeGenerationScope } from "./runtime/generation-scope.js";
import { capturePluginSessionDeletionFinalizers } from "./session-deletion-finalizers.js";
import { createPluginRecord } from "./status.test-fixtures.js";

async function waitForCleanupSignal(signal: Promise<void>, label: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 500);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

const makeRoute = (path: string): PluginHttpRouteRegistration => ({
  path,
  handler: () => {},
  auth: "gateway",
  match: "exact",
});

function activateSessionDeletionFinalizer(
  handler: PluginSessionDeletionFinalizer,
  options: { activate?: boolean; agentHarnessId?: string; pluginId?: string } = {},
) {
  const fixture = createPluginRegistryFixture();
  const agentHarnessId = options.agentHarnessId ?? "codex";
  const record = createPluginRecord({
    id: options.pluginId ?? "session-finalizer",
    agentHarnessIds: [agentHarnessId],
  });
  registerTestPlugin({
    ...fixture,
    record,
    register(api) {
      if (!api.onSessionDeleted) {
        throw new Error("session deletion finalizer registration unavailable");
      }
      api.onSessionDeleted({ agentHarnessId, handler });
    },
  });
  if (options.activate !== false) {
    setActivePluginRegistry(fixture.registry.registry);
  }
  return { registry: fixture.registry.registry, record };
}

describe("setActivePluginRegistry", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("does not carry forward httpRoutes when new registry has none", () => {
    const oldRegistry = createEmptyPluginRegistry();
    const fakeRoute = makeRoute("/test");
    oldRegistry.httpRoutes.push(fakeRoute);
    setActivePluginRegistry(oldRegistry);
    expect(getActivePluginRegistry()?.httpRoutes).toHaveLength(1);

    const newRegistry = createEmptyPluginRegistry();
    expect(newRegistry.httpRoutes).toHaveLength(0);
    setActivePluginRegistry(newRegistry);
    expect(getActivePluginRegistry()?.httpRoutes).toHaveLength(0);
  });

  it("does not carry forward when new registry already has routes", () => {
    const oldRegistry = createEmptyPluginRegistry();
    oldRegistry.httpRoutes.push(makeRoute("/old"));
    setActivePluginRegistry(oldRegistry);

    const newRegistry = createEmptyPluginRegistry();
    const newRoute = makeRoute("/new");
    newRegistry.httpRoutes.push(newRoute);
    setActivePluginRegistry(newRegistry);
    expect(getActivePluginRegistry()?.httpRoutes).toHaveLength(1);
    expect(getActivePluginRegistry()?.httpRoutes[0]).toEqual(newRoute);
  });

  it("does not carry forward when same registry is set again", () => {
    const registry = createEmptyPluginRegistry();
    registry.httpRoutes.push(makeRoute("/test"));
    setActivePluginRegistry(registry);
    setActivePluginRegistry(registry);
    expect(getActivePluginRegistry()?.httpRoutes).toHaveLength(1);
  });

  it("does not treat bundle-only loaded entries as imported runtime plugins", () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(
      createPluginRecord({
        id: "bundle-only",
        name: "Bundle Only",
        source: "/tmp/bundle",
        origin: "bundled",
        format: "bundle",
        configSchema: true,
      }),
      createPluginRecord({
        id: "runtime-plugin",
        name: "Runtime Plugin",
        source: "/tmp/runtime",
        format: "openclaw",
        configSchema: true,
      }),
    );

    setActivePluginRegistry(registry);

    expect(listImportedRuntimePluginIds()).toEqual(["runtime-plugin"]);
  });

  it.each([
    {
      name: "same active registry is refreshed",
      refresh: (nextRegistry: ReturnType<typeof createEmptyPluginRegistry>) => {
        setActivePluginRegistry(nextRegistry);
      },
    },
    {
      name: "active registry advances again",
      refresh: () => {
        setActivePluginRegistry(createEmptyPluginRegistry());
      },
    },
  ] as const)("continues cleanup when the $name", async ({ refresh }) => {
    let releaseFirstCleanup: (() => void) | undefined;
    let markFirstCleanupStarted: (() => void) | undefined;
    let markSecondCleanupCalled: (() => void) | undefined;
    const firstCleanupStarted = new Promise<void>((resolve) => {
      markFirstCleanupStarted = resolve;
    });
    const secondCleanupCalled = new Promise<void>((resolve) => {
      markSecondCleanupCalled = resolve;
    });
    if (!markFirstCleanupStarted || !markSecondCleanupCalled) {
      throw new Error("Expected cleanup signal callbacks to be initialized");
    }
    const notifyFirstCleanupStarted = markFirstCleanupStarted;
    const notifySecondCleanupCalled = markSecondCleanupCalled;
    const previous = createEmptyPluginRegistry();
    previous.plugins.push(
      createPluginRecord({
        id: "cleanup-refresh-race",
        name: "Cleanup Refresh Race",
        status: "loaded",
      }),
    );
    previous.runtimeLifecycles = [
      {
        pluginId: "cleanup-refresh-race",
        pluginName: "Cleanup Refresh Race",
        lifecycle: {
          id: "first-cleanup",
          async cleanup() {
            notifyFirstCleanupStarted();
            await new Promise<void>((resolve) => {
              releaseFirstCleanup = resolve;
            });
          },
        },
        source: "/virtual/cleanup-refresh-race/index.ts",
        rootDir: "/virtual/cleanup-refresh-race",
      },
      {
        pluginId: "cleanup-refresh-race",
        pluginName: "Cleanup Refresh Race",
        lifecycle: {
          id: "second-cleanup",
          cleanup() {
            notifySecondCleanupCalled();
          },
        },
        source: "/virtual/cleanup-refresh-race/index.ts",
        rootDir: "/virtual/cleanup-refresh-race",
      },
    ];
    const next = createEmptyPluginRegistry();

    setActivePluginRegistry(previous);
    setActivePluginRegistry(next);
    await waitForCleanupSignal(firstCleanupStarted, "first cleanup start");

    refresh(next);
    if (!releaseFirstCleanup) {
      throw new Error("Expected first cleanup release callback to be initialized");
    }
    releaseFirstCleanup();

    await waitForCleanupSignal(secondCleanupCalled, "second cleanup");
  });

  it("includes plugin ids imported before registration failed", () => {
    recordImportedPluginId("broken-plugin");

    expect(listImportedRuntimePluginIds()).toEqual(["broken-plugin"]);
  });

  it("clears the root only after its host cleanup completes", async () => {
    let cleanupCount = 0;
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(
      createPluginRecord({ id: "cleanup-on-close", name: "Cleanup on close", status: "loaded" }),
    );
    registry.runtimeLifecycles = [
      {
        pluginId: "cleanup-on-close",
        pluginName: "Cleanup on close",
        lifecycle: {
          id: "cleanup-on-close",
          cleanup() {
            cleanupCount += 1;
          },
        },
        source: "/virtual/cleanup-on-close/index.ts",
        rootDir: "/virtual/cleanup-on-close",
      },
    ];
    setActivePluginRegistry(registry);

    await clearActivePluginRegistry();

    expect(getActivePluginRegistry()).toBeNull();
    expect(cleanupCount).toBe(1);
  });

  it("clears plugin host run contexts with the active registry", async () => {
    setPluginRunContext({
      pluginId: "runtime-test",
      patch: { runId: "run-1", namespace: "state", value: { ready: true } },
    });

    await clearActivePluginRegistry();

    expect(
      getPluginRunContext({
        pluginId: "runtime-test",
        get: { runId: "run-1", namespace: "state" },
      }),
    ).toBeUndefined();
  });

  it("awaits only the deleted session's matching harness owner", async () => {
    let release: (() => void) | undefined;
    let completed = false;
    let receivedEvent: unknown;
    let retainedAuthority: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    activateSessionDeletionFinalizer(async (event, { assertCurrent }) => {
      assertCurrent();
      retainedAuthority = assertCurrent;
      receivedEvent = event;
      await pending;
      assertCurrent();
      completed = true;
    });
    const snapshot = capturePluginSessionDeletionFinalizers();
    expect(snapshot).toBeDefined();
    const event = {
      agentId: "agent",
      agentHarnessId: "codex",
      sessionKey: "agent:agent:main",
      sessionId: "session-id",
      lifecycleRevision: "revision-1",
    };

    await snapshot!.finalize({ ...event, agentHarnessId: "other-harness" });
    expect(receivedEvent).toBeUndefined();

    const finalization = snapshot!.finalize(event);

    expect(completed).toBe(false);
    expect(receivedEvent).toEqual(event);
    release?.();
    await finalization;
    expect(completed).toBe(true);
    expect(() => retainedAuthority?.()).toThrow("no longer current");
  });

  it("rejects finalizers for foreign harnesses and duplicate harness owners", () => {
    const fixture = createPluginRegistryFixture();
    const record = createPluginRecord({ id: "harness-owner", agentHarnessIds: ["owned"] });
    registerTestPlugin({
      ...fixture,
      record,
      register(api) {
        api.onSessionDeleted?.({ agentHarnessId: "foreign", handler: () => {} });
        api.onSessionDeleted?.({ agentHarnessId: "", handler: () => {} });
        api.onSessionDeleted?.({ agentHarnessId: "owned", handler: () => {} });
        api.onSessionDeleted?.({ agentHarnessId: "owned", handler: () => {} });
      },
    });

    expect(fixture.registry.registry.sessionDeletionFinalizers).toHaveLength(1);
    expect(fixture.registry.registry.sessionDeletionFinalizers[0]?.agentHarnessId).toBe("owned");
    expect(fixture.registry.registry.diagnostics.map(({ message }) => message)).toEqual([
      "session deletion finalizer requires an agent harness owned by the plugin: foreign",
      "session deletion finalizer requires an agent harness owned by the plugin: <missing>",
      "session deletion finalizer already registered for agent harness: owned",
    ]);
  });

  it("keeps a request's staged registry until replacement commits", async () => {
    const called: string[] = [];
    const previous = activateSessionDeletionFinalizer(() => {
      called.push("request-owner");
    });
    const candidate = activateSessionDeletionFinalizer(
      () => {
        called.push("staged-candidate");
      },
      {
        activate: false,
        pluginId: "candidate-owner",
      },
    );
    stageActivePluginRegistry(candidate.registry, null, "default");

    const snapshot = withPluginRuntimeGatewayRequestScope(
      { pluginRegistry: previous.registry, isWebchatConnect: () => false },
      () => capturePluginSessionDeletionFinalizers(),
    );
    expect(snapshot).toBeDefined();
    const event = {
      agentId: "agent",
      agentHarnessId: "codex",
      sessionKey: "session",
      sessionId: "id",
    };

    await snapshot!.finalize(event);
    expect(called).toEqual(["request-owner"]);

    commitStagedPluginRegistry(previous.registry, candidate.registry);
    await expect(snapshot!.finalize(event)).rejects.toThrow("no longer current");
    expect(called).toEqual(["request-owner"]);
  });

  it("prefers the prepared runtime generation over request and active registries", async () => {
    const called: string[] = [];
    const generation = activateSessionDeletionFinalizer(() => {
      called.push("generation");
    });
    const request = activateSessionDeletionFinalizer(
      () => {
        called.push("request");
      },
      {
        activate: false,
        pluginId: "request-owner",
      },
    );
    stageActivePluginRegistry(request.registry, null, "default");

    const snapshot = withPluginRuntimeGenerationScope(
      {
        config: {},
        metadataSnapshot: createPluginMetadataSnapshot({
          manifestRegistry: { plugins: [], diagnostics: [] },
        }),
        pluginRegistry: generation.registry,
      },
      () =>
        withPluginRuntimeGatewayRequestScope(
          { pluginRegistry: request.registry, isWebchatConnect: () => false },
          () => capturePluginSessionDeletionFinalizers(),
        ),
    );

    await snapshot?.finalize({
      agentId: "agent",
      agentHarnessId: "codex",
      sessionKey: "session",
      sessionId: "id",
    });
    expect(called).toEqual(["generation"]);
  });

  it("rejects a revoked record even when that same record is reactivated", async () => {
    let called = false;
    const owner = activateSessionDeletionFinalizer(() => {
      called = true;
    });
    const snapshot = capturePluginSessionDeletionFinalizers();
    expect(snapshot).toBeDefined();
    revokePluginRecordLifecycleEpoch(owner.registry, owner.record);
    activatePluginRecordLifecycleEpoch(owner.registry, owner.record);

    await expect(
      snapshot!.finalize({
        agentId: "agent",
        agentHarnessId: "codex",
        sessionKey: "session",
        sessionId: "id",
      }),
    ).rejects.toThrow("no longer current");
    expect(called).toBe(false);
  });

  it("cannot regain revoked record authority through a new finalizer capture", async () => {
    let calls = 0;
    const owner = activateSessionDeletionFinalizer(() => {
      calls += 1;
    });
    const event = {
      agentId: "agent",
      agentHarnessId: "codex",
      sessionKey: "session",
      sessionId: "id",
    };
    revokePluginRecordLifecycleEpoch(owner.registry, owner.record);

    const revoked = capturePluginSessionDeletionFinalizers();
    expect(revoked).toBeDefined();
    await expect(revoked!.finalize(event)).rejects.toThrow("no longer current");
    expect(calls).toBe(0);

    setActivePluginRegistry(owner.registry);
    const reactivated = capturePluginSessionDeletionFinalizers();
    await reactivated?.finalize(event);
    expect(calls).toBe(1);
    await expect(revoked!.finalize(event)).rejects.toThrow("no longer current");
  });

  it("rejects a retired registry even when the same registry is reactivated", async () => {
    const owner = activateSessionDeletionFinalizer(() => {});
    const snapshot = capturePluginSessionDeletionFinalizers();
    expect(snapshot).toBeDefined();
    setActivePluginRegistry(createEmptyPluginRegistry());
    setActivePluginRegistry(owner.registry);

    expect(() => snapshot!.assertCurrent("codex")).toThrow("no longer current");
    await expect(
      snapshot!.finalize({
        agentId: "agent",
        agentHarnessId: "codex",
        sessionKey: "session",
        sessionId: "id",
      }),
    ).rejects.toThrow("no longer current");
  });

  it("revokes retained finalizer authority when its plugin owner changes during awaited work", async () => {
    let release: (() => void) | undefined;
    let irreversibleAction = false;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    activateSessionDeletionFinalizer(async (_event, { assertCurrent }) => {
      await pending;
      assertCurrent();
      irreversibleAction = true;
    });
    const snapshot = capturePluginSessionDeletionFinalizers();
    expect(snapshot).toBeDefined();
    const finalization = snapshot!.finalize({
      agentId: "agent",
      agentHarnessId: "codex",
      sessionKey: "session",
      sessionId: "id",
    });

    setActivePluginRegistry(createEmptyPluginRegistry());
    release?.();

    await expect(finalization).rejects.toThrow("no longer current");
    expect(irreversibleAction).toBe(false);
  });
});
