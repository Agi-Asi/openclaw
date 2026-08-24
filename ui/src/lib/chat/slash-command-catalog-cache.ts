import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { invalidateChatMetadataStore } from "./chat-metadata-store.ts";
import type { SlashCommandDef } from "./commands.ts";

type SlashCommandCatalogCacheEntry = {
  commands?: readonly SlashCommandDef[];
  expiresAt: number;
  inFlight?: Promise<readonly SlashCommandDef[]>;
};

const remoteCatalogs = new WeakMap<
  GatewayBrowserClient,
  Map<string, SlashCommandCatalogCacheEntry>
>();
const catalogGenerations = new WeakMap<GatewayBrowserClient, number>();

export function getSlashCommandCatalogGeneration(client: GatewayBrowserClient): number {
  return catalogGenerations.get(client) ?? 0;
}

export function getSlashCommandCatalogCache(
  client: GatewayBrowserClient,
): Map<string, SlashCommandCatalogCacheEntry> {
  let catalogs = remoteCatalogs.get(client);
  if (!catalogs) {
    catalogs = new Map();
    remoteCatalogs.set(client, catalogs);
  }
  return catalogs;
}

export function invalidateSlashCommandCatalog(client: GatewayBrowserClient): void {
  invalidateChatMetadataStore(client);
  catalogGenerations.set(client, getSlashCommandCatalogGeneration(client) + 1);
  remoteCatalogs.delete(client);
}
