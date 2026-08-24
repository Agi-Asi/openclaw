// Model auth status methods report provider credential health, profile expiry,
// usage windows, cleanup actions, and auth-state refreshes.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { tryResolveAmbientOwnerAgentId } from "../../agents/agent-scope-config.js";
import { type AuthHealthSummary, buildAuthHealthSummary } from "../../agents/auth-health.js";
import {
  type AuthProfileStore,
  clearAuthProfileCooldown,
  ensureAuthProfileStoreWithoutExternalProfiles,
  externalCliDiscoveryForConfigStatus,
  listProfilesForProvider,
  removeAuthProfilesAcrossOwnerStores,
  resolvePersistedAuthProfileOwnerAgentDir,
} from "../../agents/auth-profiles.js";
import {
  listConfiguredExternalCliProfileMetadataIds,
  normalizeExternalCliProfileMetadata,
} from "../../agents/auth-profiles/external-cli-profile-metadata.js";
import { getRuntimeExternalCliProfileIds } from "../../agents/auth-profiles/runtime-external-profile-references.js";
import {
  isNonSecretApiKeyMarker,
  NON_ENV_SECRETREF_MARKER,
} from "../../agents/model-auth-markers.js";
import { resolveProviderEntryApiKeyProfileReference } from "../../agents/model-auth.js";
import {
  clearCurrentProviderAuthState,
  warmCurrentProviderAuthStateOffMainThread,
} from "../../agents/model-provider-auth.js";
import {
  type ProviderAuthAliasLookupParams,
  resolveProviderIdForAuth,
} from "../../agents/provider-auth-aliases.js";
import type { OpenClawConfig } from "../../config/config.js";
import { hasConfiguredSecretInput } from "../../config/types.secrets.js";
import { resolveUsageProviderId } from "../../infra/provider-usage.shared.js";
import type { UsageProviderId } from "../../infra/provider-usage.types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { refreshActiveProviderAuthRuntimeSnapshot } from "../../secrets/runtime.js";
import { abortChatRunsForProvider } from "../chat-abort.js";
import { loadDeferredCatalog, readPreparedCatalog } from "../server-model-catalog-auth.js";
import { formatForLog } from "../ws-log.js";
import { modelAuthAgentScopeError, resolveModelAuthAgentScope } from "./model-auth-agent-scope.js";
import { resolveModelProviderCapabilities } from "./model-provider-capabilities.js";
import {
  createAuthLogoutAbortOps,
  readLogoutProfileSelection,
  removeProviderAuthProfilesAcrossOwnerStores,
} from "./models-auth-logout.js";
import { runModelAuthProfileMutation, updateModelAuthProfileOrder } from "./models-auth-order.js";
import { resolveProviderApiKeys } from "./models-auth-status-api-keys.js";
import { mapModelAuthStatusProvider } from "./models-auth-status-profiles.js";
import { suppressSyntheticAliasRowsCoveredByExternalCli } from "./models-auth-status-projection.js";
import {
  clearModelAuthStatusUsageCache,
  loadProfileUsageStaleWhileRevalidate,
  readProviderUsageStaleWhileRevalidate,
} from "./models-auth-status-usage-cache.js";
import type {
  ModelAuthLogoutResult,
  ModelAuthStatusProvider,
  ModelAuthStatusResult,
  ModelProviderCapability,
} from "./models-auth-status.types.js";
import { getProviderUsageRuntimeSnapshot } from "./provider-usage-runtime.js";
import type { GatewayRequestHandlers } from "./types.js";

export type {
  ModelAuthExpiry,
  ModelAuthLogoutResult,
  ModelAuthStatusProfile,
  ModelAuthStatusProvider,
  ModelAuthStatusResult,
  ModelProviderCapability,
} from "./models-auth-status.types.js";
export { aggregateRefreshableAuthStatus } from "./models-auth-status-profiles.js";

const log = createSubsystemLogger("models-auth-status");
const apiKeyUsageStatusProviders = new Set<UsageProviderId>(["clawrouter", "deepseek"]);

type PreparedAuthMetadataLookupParams = ProviderAuthAliasLookupParams & {
  metadataSnapshot: NonNullable<
    Awaited<ReturnType<typeof readPreparedCatalog>>
  >["metadataSnapshot"];
};

function buildProviderCapabilities(params: {
  config: OpenClawConfig;
  workspaceDir: string;
  metadataSnapshot: NonNullable<
    Awaited<ReturnType<typeof readPreparedCatalog>>
  >["metadataSnapshot"];
}): ModelProviderCapability[] {
  return resolveModelProviderCapabilities(params).capabilities;
}

function resolveAuthRefreshScope(cfg: OpenClawConfig): {
  providerIds: string[];
  profileIds?: string[];
} {
  const discovery = externalCliDiscoveryForConfigStatus({ cfg });
  if (discovery.mode !== "scoped") {
    return { providerIds: [] };
  }
  const providerIds = [...(discovery.providerIds ?? [])];
  const profileIds = [...(discovery.profileIds ?? [])];
  return {
    providerIds,
    ...(profileIds.length > 0 ? { profileIds } : {}),
  };
}

/**
 * Invalidate auxiliary usage and prepared provider-auth state after an auth
 * mutation. Auth health itself is rebuilt on every request; only outbound
 * usage enrichment is cached.
 */
export function invalidateModelAuthStatusCache(): void {
  clearModelAuthStatusUsageCache();
  // The prepared provider-auth map (model-provider-auth.ts) was built from
  // the pre-mutation auth state, so it must be invalidated alongside this
  // cache whenever an auth-profile mutation lands (logout, login, token
  // rotation, etc.). Without this, `/models` and pickers keep advertising
  // providers the running gateway can no longer authenticate.
  clearCurrentProviderAuthState();
}

async function refreshModelAuthStatusRuntimeState(): Promise<void> {
  // Durable and CLI auth refresh into the transient prepared owner below. Do not clear the
  // process-wide warmed auth state for a read; mutations still invalidate it explicitly.
  try {
    await refreshActiveProviderAuthRuntimeSnapshot();
  } catch (err) {
    log.warn(`runtime auth snapshot refresh before auth status failed: ${formatForLog(err)}`);
  }
}

function readProviderParam(params: Record<string, unknown>): string | null {
  const raw = params.provider;
  if (typeof raw !== "string") {
    return null;
  }
  const provider = normalizeProviderId(raw);
  return provider || null;
}

function resolveConfigBoundProfileIds(
  cfg: OpenClawConfig,
  store: AuthProfileStore,
  authAliasLookupParams?: ProviderAuthAliasLookupParams,
): Set<string> {
  const profileIds = new Set<string>();
  for (const provider of Object.keys(cfg.models?.providers ?? {})) {
    const reference = resolveProviderEntryApiKeyProfileReference({
      cfg,
      authAliasLookupParams,
      provider,
      store,
    });
    if (reference.kind === "profile" || reference.kind === "profile-incompatible") {
      profileIds.add(reference.profileId);
    }
  }
  return profileIds;
}

function resolveConfiguredProviders(
  cfg: OpenClawConfig,
  apiKeys: ReadonlyMap<string, ModelAuthStatusProvider["apiKey"]>,
): {
  providers: string[];
  expectsOAuth: Set<string>;
  directModelAuthProviders: Set<string>;
} {
  const out = new Set<string>();
  const expectsOAuth = new Set<string>();
  const directModelAuthProviders = new Set<string>();
  for (const [id, provider] of Object.entries(cfg.models?.providers ?? {})) {
    const normalized = normalizeProviderId(id);
    if (!normalized) {
      continue;
    }
    const rawKey = typeof provider?.apiKey === "string" ? provider.apiKey.trim() : "";
    const hasApiKey =
      hasConfiguredSecretInput(provider?.apiKey, cfg.secrets?.defaults) &&
      (rawKey === NON_ENV_SECRETREF_MARKER ||
        !isNonSecretApiKeyMarker(rawKey, { includeEnvVarName: false }));
    const mode = provider?.auth;
    if (mode !== "oauth" && mode !== "token" && !hasApiKey) {
      continue;
    }
    directModelAuthProviders.add(normalized);
    if (apiKeys.has(normalized)) {
      continue;
    }
    out.add(normalized);
    if (mode === "oauth") {
      expectsOAuth.add(normalized);
    }
  }
  // auth.profiles opt in via `mode: oauth | token`; API-key profiles have no lifecycle.
  for (const profile of Object.values(cfg.auth?.profiles ?? {})) {
    const provider = profile?.provider;
    const mode = profile?.mode;
    if (
      typeof provider !== "string" ||
      provider.length === 0 ||
      (mode !== "oauth" && mode !== "token")
    ) {
      continue;
    }
    const normalized = normalizeProviderId(provider);
    if (!normalized) {
      continue;
    }
    if (apiKeys.has(normalized)) {
      continue;
    }
    out.add(normalized);
    if (mode === "oauth") {
      expectsOAuth.add(normalized);
    }
  }
  return { providers: Array.from(out), expectsOAuth, directModelAuthProviders };
}

function resolveLegacyExternalCliAliasProfileIds(
  cfg: OpenClawConfig,
  directModelAuthProviders: ReadonlySet<string>,
): Map<string, string> {
  const profiles = cfg.auth?.profiles;
  const aliases = new Map<string, string>();
  for (const profileId of listConfiguredExternalCliProfileMetadataIds(profiles)) {
    const profile = profiles?.[profileId];
    const canonical = normalizeExternalCliProfileMetadata(profileId, profile);
    if (!profile || !canonical) {
      continue;
    }
    const provider = normalizeProviderId(profile.provider);
    const hasIndependentAuthProfile = Object.entries(profiles ?? {}).some(
      ([otherProfileId, otherProfile]) =>
        otherProfileId !== profileId &&
        normalizeProviderId(otherProfile?.provider) === provider &&
        (otherProfile?.mode === "oauth" || otherProfile?.mode === "token"),
    );
    const hasIndependentAuthOrder = Object.entries(cfg.auth?.order ?? {}).some(
      ([orderProvider, orderedProfileIds]) =>
        normalizeProviderId(orderProvider) === provider &&
        orderedProfileIds.some((orderedProfileId) => orderedProfileId !== profileId),
    );
    if (
      provider &&
      provider !== canonical.provider &&
      !directModelAuthProviders.has(provider) &&
      !hasIndependentAuthProfile &&
      !hasIndependentAuthOrder
    ) {
      aliases.set(provider, profileId);
    }
  }
  return aliases;
}

export const modelsAuthStatusHandlers: GatewayRequestHandlers = {
  "models.authOrderSet": async ({ params, respond, context }) => {
    const provider = readProviderParam(params);
    const profileIds = normalizeUniqueTrimmedStringList(params.profileIds);
    const expectedProfileIds = Array.isArray(params.expectedProfileIds)
      ? normalizeUniqueTrimmedStringList(params.expectedProfileIds)
      : params.expectedProfileIds === null
        ? null
        : undefined;
    const expectedProfileMembership = Array.isArray(params.expectedProfileMembership)
      ? normalizeUniqueTrimmedStringList(params.expectedProfileMembership)
      : undefined;
    if (!provider || profileIds.length === 0) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid auth order"));
      return;
    }
    try {
      const cfg = context.getRuntimeConfig();
      const scope = resolveModelAuthAgentScope(cfg, params.agentId);
      if (!scope.ok) {
        respond(false, undefined, modelAuthAgentScopeError(scope));
        return;
      }
      const authProvider = resolveProviderIdForAuth(provider, { config: cfg });
      const result = await updateModelAuthProfileOrder({
        agentDir: scope.agentDir,
        agentId: scope.agentId,
        authProvider,
        cfg,
        expectedProfileIds: Object.hasOwn(params, "expectedProfileIds")
          ? expectedProfileIds
          : undefined,
        expectedProfileMembership,
        profileIds,
        provider,
      });
      if (!result.ok) {
        const invalidProfiles = result.reason === "invalid-profiles";
        const message = invalidProfiles
          ? "profileIds contain unavailable auth profiles"
          : result.reason === "conflict"
            ? "profile order changed; refresh and retry"
            : "failed to update auth profile order";
        respond(
          false,
          undefined,
          errorShape(
            invalidProfiles ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
            message,
          ),
        );
        return;
      }
      invalidateModelAuthStatusCache();
      respond(true, { provider, profileIds }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "models.authCooldownClear": async ({ params, respond, context }) => {
    const provider = readProviderParam(params);
    const profileId = typeof params.profileId === "string" ? params.profileId.trim() : "";
    if (!provider || !profileId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "provider and profileId are required"),
      );
      return;
    }
    try {
      const cfg = context.getRuntimeConfig();
      const scope = resolveModelAuthAgentScope(cfg, params.agentId);
      if (!scope.ok) {
        respond(false, undefined, modelAuthAgentScopeError(scope));
        return;
      }
      const store = ensureAuthProfileStoreWithoutExternalProfiles(scope.agentDir);
      const credential = store.profiles[profileId];
      if (
        !credential ||
        resolveProviderIdForAuth(credential.provider, { config: cfg }) !==
          resolveProviderIdForAuth(provider, { config: cfg })
      ) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "profile is unavailable for this provider"),
        );
        return;
      }
      const ownerAgentDir = resolvePersistedAuthProfileOwnerAgentDir({
        agentDir: scope.agentDir,
        profileId,
      });
      const cleared = await clearAuthProfileCooldown({
        store,
        profileId,
        agentDir: ownerAgentDir,
      });
      if (!cleared.ok) {
        throw new Error("Could not update account availability. Try again.");
      }
      invalidateModelAuthStatusCache();
      respond(true, { provider, profileId }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "models.authLogout": async ({ params, respond, context }) => {
    const provider = readProviderParam(params);
    if (!provider) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "provider is required"));
      return;
    }
    const selection = readLogoutProfileSelection(params);
    if (!selection.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, selection.message));
      return;
    }
    try {
      const cfg = context.getRuntimeConfig();
      const scope = resolveModelAuthAgentScope(cfg, params.agentId);
      if (!scope.ok) {
        respond(false, undefined, modelAuthAgentScopeError(scope));
        return;
      }
      const { agentDir } = scope;
      const authProvider = resolveProviderIdForAuth(provider, { config: cfg });
      const store = ensureAuthProfileStoreWithoutExternalProfiles(agentDir);
      const authAliasLookupParams = { config: cfg };
      const availableProfiles = listProfilesForProvider(store, authProvider, authAliasLookupParams);
      const removedProfiles = selection.profileIds ?? availableProfiles;
      if (
        selection.profileIds &&
        selection.profileIds.some((profileId) => {
          const profile = store.profiles[profileId];
          return (
            !availableProfiles.includes(profileId) ||
            (profile?.type !== "oauth" && profile?.type !== "token")
          );
        })
      ) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "profileIds contain unavailable auth profiles"),
        );
        return;
      }
      const configBoundProfileIds = selection.profileIds
        ? resolveConfigBoundProfileIds(cfg, store)
        : null;
      if (selection.profileIds?.some((profileId) => configBoundProfileIds?.has(profileId))) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "profileIds contain config-bound auth profiles"),
        );
        return;
      }
      const removed = await runModelAuthProfileMutation(authProvider, async () =>
        selection.profileIds
          ? await removeAuthProfilesAcrossOwnerStores({ agentDir, profileIds: removedProfiles })
          : removeProviderAuthProfilesAcrossOwnerStores({
              provider: authProvider,
              agentDir,
              profileIds: removedProfiles,
            }),
      );
      if (!removed) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            `failed to remove saved auth profiles for provider ${provider}`,
          ),
        );
        return;
      }
      // Fence auxiliary usage work that captured the removed profiles before
      // logout. Its later completion must not repopulate the cache.
      invalidateModelAuthStatusCache();
      await refreshActiveProviderAuthRuntimeSnapshot();
      void warmCurrentProviderAuthStateOffMainThread(context.getRuntimeConfig()).catch(
        (err: unknown) => {
          log.warn(`provider auth state rewarm after logout failed: ${formatForLog(err)}`);
        },
      );
      // A provider-wide abort would terminate runs using credentials this
      // logout preserved (other profiles, tokens, or the config API key). Abort
      // entries do not carry the profile id, so a targeted logout cannot scope
      // the abort and instead leaves in-flight runs to fail on their next
      // request; only a full-provider logout revokes everything and aborts.
      const { runIds: abortedRunIds } = selection.profileIds
        ? { runIds: [] as string[] }
        : abortChatRunsForProvider(createAuthLogoutAbortOps(context), {
            cfg,
            providerId: authProvider,
            agentId: scope.agentId,
            stopReason: "auth-revoked",
          });
      const result: ModelAuthLogoutResult = {
        provider,
        removedProfiles,
        abortedRunIds,
      };
      respond(true, result, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "models.authStatus": async ({ params, respond, context }) => {
    const now = Date.now();
    const refreshRequested = Boolean(params.refresh);
    const resolveScope = (cfg: OpenClawConfig) =>
      resolveModelAuthAgentScope(
        cfg,
        params.agentId === undefined || params.agentId === ""
          ? tryResolveAmbientOwnerAgentId(cfg)
          : params.agentId,
      );
    try {
      let cfg = context.getRuntimeConfig();
      let scope = resolveScope(cfg);
      if (!scope.ok) {
        respond(false, undefined, modelAuthAgentScopeError(scope));
        return;
      }
      if (refreshRequested) {
        await refreshModelAuthStatusRuntimeState();
        cfg = context.getRuntimeConfig();
        scope = resolveScope(cfg);
        if (!scope.ok) {
          respond(false, undefined, modelAuthAgentScopeError(scope));
          return;
        }
      }
      const preparedSnapshot = refreshRequested
        ? await loadDeferredCatalog(context, scope.agentId, {
            readOnly: true,
            authScope: resolveAuthRefreshScope(cfg),
            refreshAuth: true,
          })
        : await readPreparedCatalog(context, scope.agentId);
      if (!preparedSnapshot) {
        throw new Error(`prepared model auth owner is unavailable (${scope.agentId})`);
      }
      cfg = preparedSnapshot.config;
      const { agentId, agentDir, authStore: store, workspaceDir } = preparedSnapshot;
      // Generic auth helpers may consult provider metadata indirectly. Carry this owner's exact
      // snapshot through them so a global miss cannot rediscover plugins on the event loop.
      const authAliasLookupParams: PreparedAuthMetadataLookupParams = {
        workspaceDir,
        metadataSnapshot: preparedSnapshot.metadataSnapshot,
        includeUntrustedWorkspacePlugins: false,
      };
      const apiKeys = resolveProviderApiKeys(cfg, store, authAliasLookupParams);
      const configured = resolveConfiguredProviders(cfg, apiKeys);
      const statusProviderIds = new Set(configured.providers);
      for (const provider of apiKeys.keys()) {
        statusProviderIds.add(provider);
      }
      for (const profile of Object.values(store.profiles)) {
        const provider = normalizeProviderId(profile.provider);
        if (provider) {
          statusProviderIds.add(provider);
        }
      }
      const authHealth: AuthHealthSummary = buildAuthHealthSummary({
        store,
        cfg,
        providers: statusProviderIds.size > 0 ? [...statusProviderIds] : undefined,
        allowKeychainPrompt: false,
        authAliasLookupParams,
      });

      const profileUsageTargets = authHealth.profiles.flatMap((profile) => {
        if (profile.type !== "oauth" && profile.type !== "token") {
          return [];
        }
        const providerId = resolveUsageProviderId(profile.provider, {
          credentialType: profile.type,
        });
        return providerId ? [{ profileId: profile.profileId, providerId }] : [];
      });
      // Static API-key usage remains provider-scoped. Refreshable credentials
      // are queried separately so each account keeps its own quota.
      const usageProviderIds = [
        ...new Set(
          authHealth.profiles
            .filter((p) => {
              const usageProvider = resolveUsageProviderId(p.provider, {
                credentialType: p.type,
              });
              return usageProvider ? apiKeyUsageStatusProviders.has(usageProvider) : false;
            })
            .map((p) => resolveUsageProviderId(p.provider, { credentialType: p.type }))
            .filter((id): id is UsageProviderId => Boolean(id)),
        ),
      ];

      const providerUsageRuntime = getProviderUsageRuntimeSnapshot({
        config: cfg,
        agentId,
        agentDir,
        store,
      });
      const usageByProfile = await loadProfileUsageStaleWhileRevalidate({
        agentId,
        agentDir,
        workspaceDir,
        authStore: providerUsageRuntime.store,
        configRef: cfg,
        credentialKey: providerUsageRuntime.credentialKey,
        forceRefresh: refreshRequested,
        targets: profileUsageTargets,
        now,
      });
      const usageByProvider = readProviderUsageStaleWhileRevalidate({
        agentId,
        agentDir,
        authStore: providerUsageRuntime.store,
        configRef: cfg,
        credentialKey: providerUsageRuntime.credentialKey,
        forceRefresh: refreshRequested,
        providerIds: usageProviderIds,
        now,
      });

      const externalProfileIds = new Set(store.runtimeExternalProfileIds ?? []);
      const externalCliProfileIds = new Set(getRuntimeExternalCliProfileIds(store));
      const logoutProfileIds = new Set(
        Object.entries(store.profiles)
          .filter(
            ([profileId, profile]) =>
              !externalProfileIds.has(profileId) &&
              (profile.type === "oauth" || profile.type === "token"),
          )
          .map(([profileId]) => profileId),
      );
      const configBoundProfileIds = resolveConfigBoundProfileIds(cfg, store, authAliasLookupParams);
      const legacyExternalCliAliasProfileIds = resolveLegacyExternalCliAliasProfileIds(
        cfg,
        configured.directModelAuthProviders,
      );
      const providers = suppressSyntheticAliasRowsCoveredByExternalCli(
        authHealth.providers.map((prov) =>
          mapModelAuthStatusProvider({
            provider: prov,
            config: cfg,
            usageByProvider,
            usageByProfile,
            expectsOAuth: configured.expectsOAuth,
            apiKeys,
            logoutProfileIds,
            configBoundProfileIds,
            externalCliProfileIds,
            store,
          }),
        ),
        externalCliProfileIds,
        legacyExternalCliAliasProfileIds,
      );
      const providerCapabilities = buildProviderCapabilities({
        config: cfg,
        workspaceDir,
        metadataSnapshot: preparedSnapshot.metadataSnapshot,
      });
      const result: ModelAuthStatusResult = { ts: now, providers, providerCapabilities };
      respond(true, result, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};
