import type { PluginRegistryState } from "./registry-state.js";
import type { PluginRecord } from "./registry-types.js";
import type {
  PluginConversationBindingResolvedEvent,
  PluginSessionDeletionRegistration,
} from "./types.js";

export function createSessionLifecycleRegistrars(state: PluginRegistryState) {
  const { registry, pushDiagnostic } = state;

  const registerConversationBindingResolvedHandler = (
    record: PluginRecord,
    handler: (event: PluginConversationBindingResolvedEvent) => void | Promise<void>,
  ) => {
    registry.conversationBindingResolvedHandlers.push({
      pluginId: record.id,
      pluginName: record.name,
      pluginRoot: record.rootDir,
      handler,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerSessionDeletionFinalizer = (
    record: PluginRecord,
    registration: PluginSessionDeletionRegistration,
  ) => {
    const { agentHarnessId, handler } = registration;
    const invalid =
      !record.agentHarnessIds.includes(agentHarnessId) || typeof handler !== "function";
    const duplicate = registry.sessionDeletionFinalizers.some(
      (entry) => entry.agentHarnessId === agentHarnessId,
    );
    if (invalid || duplicate) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: invalid
          ? `session deletion finalizer requires an agent harness owned by the plugin: ${agentHarnessId || "<missing>"}`
          : `session deletion finalizer already registered for agent harness: ${agentHarnessId}`,
      });
      return;
    }
    registry.sessionDeletionFinalizers.push({ record, ...registration });
  };

  return {
    registerConversationBindingResolvedHandler,
    registerSessionDeletionFinalizer,
  };
}
