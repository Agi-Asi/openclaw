import type { PluginSessionDeletionEvent } from "./plugin-api.types.js";
import { capturePluginLifecycleAuthority } from "./registry-lifecycle.js";
import { getPluginRegistryState } from "./runtime-state.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { getPluginRuntimeGenerationRegistry } from "./runtime/generation-scope.js";

/** Capture the request's exact plugin generation before its session row commits. */
export function capturePluginSessionDeletionFinalizers() {
  const registry =
    getPluginRuntimeGenerationRegistry() ??
    getPluginRuntimeGatewayRequestScope()?.pluginRegistry ??
    getPluginRegistryState()?.activeRegistry;
  if (!registry || registry.sessionDeletionFinalizers.length === 0) {
    return undefined;
  }
  const registryCurrent = capturePluginLifecycleAuthority(registry);
  if (!registryCurrent) {
    return undefined;
  }
  const finalizers = registry.sessionDeletionFinalizers.map((registration) => ({
    agentHarnessId: registration.agentHarnessId,
    handler: registration.handler,
    record: registration.record,
    isCurrent: capturePluginLifecycleAuthority(registry, registration.record),
  }));
  const resolveCurrentFinalizer = (agentHarnessId: string) => {
    if (!registryCurrent()) {
      throw new Error("session deletion finalizer plugin registry is no longer current");
    }
    const finalizer = finalizers.find((entry) => entry.agentHarnessId === agentHarnessId);
    if (!finalizer) {
      return undefined;
    }
    if (
      !finalizer.isCurrent?.() ||
      !finalizer.record.enabled ||
      finalizer.record.status !== "loaded"
    ) {
      throw new Error(
        `session deletion finalizer owner is no longer current: ${finalizer.record.id}`,
      );
    }
    return finalizer;
  };
  return {
    assertCurrent: (agentHarnessId: string) =>
      resolveCurrentFinalizer(agentHarnessId) !== undefined,
    finalize: async (event: PluginSessionDeletionEvent) => {
      const finalizer = resolveCurrentFinalizer(event.agentHarnessId);
      if (!finalizer) {
        return;
      }
      let active = true;
      const assertCurrent = () => {
        if (!active || resolveCurrentFinalizer(event.agentHarnessId) !== finalizer) {
          throw new Error(
            `session deletion finalizer owner is no longer current: ${finalizer.record.id}`,
          );
        }
      };
      try {
        assertCurrent();
        await finalizer.handler(event, { assertCurrent });
        assertCurrent();
      } finally {
        active = false;
      }
    },
  };
}
