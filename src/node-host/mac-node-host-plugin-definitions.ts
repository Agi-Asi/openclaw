import type { OpenClawPluginDefinition } from "../plugins/types.js";

export type BundledNodeHostPlugin = {
  definition: OpenClawPluginDefinition & { id: string; name: string };
  enabledByDefault: boolean;
};

// The macOS worker build replaces this source-only placeholder with static
// extension imports. Core typechecking must not absorb extension DOM graphs.
export const MAC_NODE_HOST_PLUGIN_DEFINITIONS: readonly BundledNodeHostPlugin[] = [];
export const MAC_NODE_HOST_PLUGIN_IDS = [
  "acpx",
  "anthropic",
  "browser",
  "codex",
  "file-transfer",
  "google-meet",
  "logbook",
  "ollama",
  "opencode",
  "teams-meetings",
  "zoom-meetings",
] as const;
export const MAC_NODE_HOST_PLUGIN_DEFAULTS: Readonly<Record<string, boolean>> = {
  acpx: true,
  anthropic: true,
  browser: true,
  codex: false,
  "file-transfer": true,
  "google-meet": true,
  logbook: false,
  ollama: true,
  opencode: true,
  "teams-meetings": true,
  "zoom-meetings": true,
};
