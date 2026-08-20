import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BundledNodeHostPlugin } from "./mac-node-host-plugin-definitions.js";
import {
  createMacNodeHostPluginRegistry,
  MAC_NODE_HOST_PLUGIN_DEFAULTS,
  MAC_NODE_HOST_PLUGIN_IDS,
} from "./mac-node-host-plugin-runtime.js";

const tempRoots: string[] = [];

function availableCommands(
  registry: ReturnType<
    (typeof import("./mac-node-host-plugin-runtime.js"))["createMacNodeHostPluginRegistry"]
  >,
  config: Record<string, unknown>,
): string[] {
  const context = { config, env: process.env } as never;
  return registry.nodeHostCommands
    .filter((entry) => entry.command.isAvailable?.(context) !== false)
    .map((entry) => entry.command.command)
    .toSorted();
}

function plugin(id: string, command: string, enabledByDefault = true): BundledNodeHostPlugin {
  return {
    enabledByDefault,
    definition: {
      id,
      name: id,
      register(api) {
        api.registerNodeHostCommand({ command, handle: async () => "{}" });
      },
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function useIsolatedState(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-mac-node-host-plugins-"));
  tempRoots.push(root);
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
}

describe("macOS bundled node-host plugin runtime", () => {
  it("matches the default external worker command surface without CUA", () => {
    useIsolatedState();
    const registry = createMacNodeHostPluginRegistry({}, [
      plugin("google-meet", "googlemeet.chrome"),
      plugin("ollama", "ollama.chat"),
      plugin("ollama-extra", "ollama.models"),
      plugin("teams-meetings", "teamsmeetings.chrome"),
      plugin("zoom-meetings", "zoommeetings.chrome"),
    ]);

    expect(MAC_NODE_HOST_PLUGIN_IDS).not.toContain("cua-computer");
    expect(MAC_NODE_HOST_PLUGIN_IDS).not.toContain("linux-node");
    expect(MAC_NODE_HOST_PLUGIN_IDS).toEqual([
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
    ]);
    for (const id of MAC_NODE_HOST_PLUGIN_IDS) {
      const manifest = JSON.parse(
        fs.readFileSync(path.join("extensions", id, "openclaw.plugin.json"), "utf8"),
      ) as { enabledByDefault?: boolean };
      expect(MAC_NODE_HOST_PLUGIN_DEFAULTS[id]).toBe(manifest.enabledByDefault === true);
    }
    expect(availableCommands(registry, {})).toEqual([
      "googlemeet.chrome",
      "ollama.chat",
      "ollama.models",
      "teamsmeetings.chrome",
      "zoommeetings.chrome",
    ]);
  });

  it("preserves plugin enablement policy inside the signed composition", () => {
    useIsolatedState();
    const registry = createMacNodeHostPluginRegistry(
      { plugins: { entries: { "google-meet": { enabled: false } } } },
      [
        plugin("google-meet", "googlemeet.chrome"),
        plugin("teams-meetings", "teamsmeetings.chrome"),
      ],
    );

    const commands = availableCommands(registry, {
      plugins: { entries: { "google-meet": { enabled: false } } },
    });
    expect(commands).not.toContain("googlemeet.chrome");
    expect(commands).toContain("teamsmeetings.chrome");
  });
});
