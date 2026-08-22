import type { SessionToolModeSelection } from "../../packages/gateway-protocol/src/index.js";
import type { PluginSessionToolModeRegistryRegistration } from "./registry-types.js";
import { getActivePluginSessionExtensionRegistry } from "./runtime.js";

type ResolvedSessionToolMode = {
  selection: SessionToolModeSelection;
  registration?: PluginSessionToolModeRegistryRegistration;
  status: "available" | "unavailable" | "incompatible";
};

function listActiveSessionToolModes(): PluginSessionToolModeRegistryRegistration[] {
  return [...(getActivePluginSessionExtensionRegistry()?.sessionToolModes ?? [])];
}

export function resolveSessionToolMode(params: {
  selection?: SessionToolModeSelection;
  runtimeId?: string;
}): ResolvedSessionToolMode | undefined {
  const registrations = listActiveSessionToolModes();
  let selection = params.selection;
  if (!selection) {
    const defaultRegistration = registrations.find(
      (entry) =>
        entry.mode.default === true &&
        entry.mode.supportedRuntimeIds.includes(params.runtimeId ?? ""),
    );
    selection = defaultRegistration
      ? { pluginId: defaultRegistration.pluginId, modeId: defaultRegistration.mode.id }
      : undefined;
  }
  if (!selection) {
    return undefined;
  }
  const registration = registrations.find(
    (entry) => entry.pluginId === selection.pluginId && entry.mode.id === selection.modeId,
  );
  if (!registration) {
    return { selection, status: "unavailable" };
  }
  const runtimeId = params.runtimeId?.trim().toLowerCase();
  if (runtimeId && !registration.mode.supportedRuntimeIds.includes(runtimeId)) {
    return { selection, registration, status: "incompatible" };
  }
  return { selection, registration, status: "available" };
}
