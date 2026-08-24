import type { CommandsListResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { peekChatMetadata } from "./chat-metadata-store.ts";
import {
  buildFallbackSlashCommands,
  buildSlashCommandsFromEntries,
  getRemoteCommandEntries,
  type SlashCommandDef,
} from "./commands.ts";
import {
  getSlashCommandCatalogCache,
  getSlashCommandCatalogGeneration,
} from "./slash-command-catalog-cache.ts";

const CATALOG_TTL_MS = 60_000;

function agentKey(agentId: string | undefined): string {
  return agentId ?? "";
}

async function requestCatalog(
  client: GatewayBrowserClient,
  agentId: string | undefined,
): Promise<SlashCommandDef[]> {
  const result = await client.request<CommandsListResult>("commands.list", {
    ...(agentId ? { agentId } : {}),
    includeArgs: true,
    scope: "text",
  });
  if (!Array.isArray(result?.commands)) {
    throw new Error("Gateway returned an invalid command catalog");
  }
  return buildSlashCommandsFromEntries(getRemoteCommandEntries(result));
}

export function loadSlashCommandCatalog(
  client: GatewayBrowserClient,
  agentId: string | undefined,
): Promise<readonly SlashCommandDef[]> {
  const metadata = peekChatMetadata(client, agentId);
  if (Array.isArray(metadata?.commands)) {
    return Promise.resolve(buildSlashCommandsFromEntries(getRemoteCommandEntries(metadata)));
  }

  const catalogs = getSlashCommandCatalogCache(client);
  const generation = getSlashCommandCatalogGeneration(client);
  const key = agentKey(agentId);
  const cached = catalogs.get(key);
  if (cached?.commands && cached.expiresAt > Date.now()) {
    return Promise.resolve(cached.commands);
  }
  if (cached?.inFlight) {
    return cached.inFlight;
  }

  const request = requestCatalog(client, agentId).then(
    (commands) => ({ commands, succeeded: true }) as const,
    () =>
      ({ commands: cached?.commands ?? buildFallbackSlashCommands(), succeeded: false }) as const,
  );
  const inFlight = request
    .then((result) => {
      if (getSlashCommandCatalogGeneration(client) !== generation) {
        return loadSlashCommandCatalog(client, agentId);
      }
      if (result.succeeded && catalogs.get(key)?.inFlight === inFlight) {
        catalogs.set(key, { commands: result.commands, expiresAt: Date.now() + CATALOG_TTL_MS });
      }
      return result.commands;
    })
    .finally(() => {
      const latest = catalogs.get(key);
      if (latest?.inFlight === inFlight) {
        delete latest.inFlight;
      }
    });
  catalogs.set(key, {
    ...(cached?.commands ? { commands: cached.commands } : {}),
    expiresAt: cached?.expiresAt ?? 0,
    inFlight,
  });
  return inFlight;
}
