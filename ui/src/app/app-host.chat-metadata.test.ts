/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { peekChatMetadata, rememberChatMetadata } from "../lib/chat/chat-metadata-store.ts";
import { loadSlashCommandCatalog } from "../lib/chat/slash-command-catalog.ts";
import "./app-host.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "./context.ts";

type ChatMetadataShell = HTMLElement & {
  agentRosterRefreshTimer: ReturnType<typeof globalThis.setTimeout> | null;
  runtime: { context: ApplicationContext };
  handleGatewayEvent: (event: { event: string; payload: unknown }) => void;
  synchronizeGateway: (snapshot: ApplicationGatewaySnapshot) => void;
};

const shells = new Set<ChatMetadataShell>();

afterEach(() => {
  for (const shell of shells) {
    if (shell.agentRosterRefreshTimer !== null) {
      globalThis.clearTimeout(shell.agentRosterRefreshTimer);
      shell.agentRosterRefreshTimer = null;
    }
  }
  shells.clear();
  vi.useRealTimers();
});

function commandCatalog(name: string) {
  return {
    commands: [
      {
        name,
        textAliases: [`/${name}`],
        description: `${name} skill`,
        source: "skill" as const,
        scope: "text" as const,
        acceptsArgs: false,
        skillModelVisible: true,
      },
    ],
  };
}

function catalogNames(catalog: Awaited<ReturnType<typeof loadSlashCommandCatalog>>) {
  return catalog.filter((command) => command.source === "skill").map((command) => command.name);
}

function createShell(client: GatewayBrowserClient) {
  const connected = {
    client,
    phase: "connected",
    sessionKey: "agent:main:main",
  } as ApplicationGatewaySnapshot;
  const context = {
    gateway: { snapshot: connected },
    runtimeConfig: {
      state: { configFormDirty: false, configSnapshot: null },
      ensureLoaded: vi.fn(async () => null),
      refresh: vi.fn(async () => null),
    },
  } as unknown as ApplicationContext;
  const shell = document.createElement("openclaw-app-shell") as unknown as ChatMetadataShell;
  shells.add(shell);
  shell.runtime = { context };
  shell.synchronizeGateway(connected);
  return { connected, shell };
}

it("invalidates chat metadata on config changes and same-client reconnects", () => {
  vi.useFakeTimers();
  const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
  const { connected, shell } = createShell(client);
  rememberChatMetadata(client, "main", { commands: [], models: [] });
  shell.handleGatewayEvent({ event: "config.changed", payload: {} });
  expect(peekChatMetadata(client, "main")).toBeUndefined();

  rememberChatMetadata(client, "main", { commands: [], models: [] });
  shell.synchronizeGateway({ ...connected, phase: "reconnecting" });
  shell.synchronizeGateway(connected);
  expect(peekChatMetadata(client, "main")).toBeUndefined();
});

it.each(["config.changed", "skills.changed"])(
  "invalidates every agent command catalog after %s",
  async (event) => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(commandCatalog("agent_a_before"))
      .mockResolvedValueOnce(commandCatalog("agent_b_before"))
      .mockResolvedValueOnce(commandCatalog("agent_a_after"))
      .mockResolvedValueOnce(commandCatalog("agent_b_after"));
    const client = { request } as unknown as GatewayBrowserClient;
    const { shell } = createShell(client);

    await loadSlashCommandCatalog(client, "agent-a");
    await loadSlashCommandCatalog(client, "agent-b");
    shell.handleGatewayEvent({ event, payload: {} });

    expect(catalogNames(await loadSlashCommandCatalog(client, "agent-a"))).toEqual([
      "agent_a_after",
    ]);
    expect(catalogNames(await loadSlashCommandCatalog(client, "agent-b"))).toEqual([
      "agent_b_after",
    ]);
    expect(request).toHaveBeenCalledTimes(4);
  },
);

it("invalidates every agent command catalog after a same-client reconnect", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(commandCatalog("agent_b_before"))
    .mockResolvedValueOnce(commandCatalog("agent_a_before"))
    .mockResolvedValueOnce(commandCatalog("agent_b_after"));
  const client = { request } as unknown as GatewayBrowserClient;
  const { connected, shell } = createShell(client);

  await loadSlashCommandCatalog(client, "agent-b");
  await loadSlashCommandCatalog(client, "agent-a");
  shell.synchronizeGateway({ ...connected, phase: "reconnecting" });
  shell.synchronizeGateway(connected);

  expect(catalogNames(await loadSlashCommandCatalog(client, "agent-b"))).toEqual(["agent_b_after"]);
  expect(request).toHaveBeenCalledTimes(3);
});
