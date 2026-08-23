/**
 * Auth profile mutation helpers.
 * Updates profile order, last-good state, usage stats, and provider profile
 * records through locked or immediate store writes.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { Result } from "@openclaw/normalization-core/result";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  type ProviderAuthAliasLookupParams,
  resolveProviderIdForAuth,
} from "../provider-auth-aliases.js";
import { normalizeAuthProfileCredential } from "./credential-normalize.js";
import type { ExternalCliAuthDiscovery } from "./external-cli-discovery.js";
import { dedupeProfileIds, listProfilesForProvider } from "./profile-list.js";
import {
  ensureAuthProfileStoreForLocalUpdate,
  resolvePersistedAuthProfileOwnerAgentDir,
  saveAuthProfileStore,
  updateAuthProfileStoresWithLocks,
  updateAuthProfileStoreWithLock,
} from "./store.js";
import type { AuthProfileCredential, AuthProfileStore, ProfileUsageStats } from "./types.js";
export {
  dedupeProfileIds,
  listProfilesForProvider,
  resolveSubscriptionAuthModeForProfiles,
} from "./profile-list.js";
export { upsertAuthProfileWithLock, upsertAuthProfileWithLockOrThrow } from "./upsert-with-lock.js";

const authProfileProfilesLog = createSubsystemLogger("agent/embedded");

function listProviderAuthStateEntries<T>(
  entries: Record<string, T> | undefined,
  provider: string,
  authAliasLookupParams?: ProviderAuthAliasLookupParams,
): Array<[string, T]> {
  const canonicalProvider = resolveProviderIdForAuth(provider, authAliasLookupParams);
  return Object.entries(entries ?? {})
    .filter(([key]) => resolveProviderIdForAuth(key, authAliasLookupParams) === canonicalProvider)
    .toSorted(([left], [right]) => left.localeCompare(right));
}

export function resolveProviderAuthStateEntry<T>(
  entries: Record<string, T> | undefined,
  provider: string,
  authAliasLookupParams?: ProviderAuthAliasLookupParams,
): { provider: string; value: T } | undefined {
  const canonicalProvider = resolveProviderIdForAuth(provider, authAliasLookupParams);
  const matches = listProviderAuthStateEntries(entries, canonicalProvider, authAliasLookupParams);
  const match =
    matches.find(([key]) => normalizeProviderId(key) === canonicalProvider) ?? matches[0];
  return match ? { provider: match[0], value: match[1] } : undefined;
}

function readProviderAuthState<T>(
  entries: Record<string, T> | undefined,
  provider: string,
  authAliasLookupParams?: ProviderAuthAliasLookupParams,
): T | undefined {
  return resolveProviderAuthStateEntry(entries, provider, authAliasLookupParams)?.value;
}

function replaceProviderAuthState<T>(
  entries: Record<string, T> | undefined,
  provider: string,
  value?: T,
  authAliasLookupParams?: ProviderAuthAliasLookupParams,
): Record<string, T> | undefined {
  const canonicalProvider = resolveProviderIdForAuth(provider, authAliasLookupParams);
  const next = Object.fromEntries(
    Object.entries(entries ?? {}).filter(
      ([key]) => resolveProviderIdForAuth(key, authAliasLookupParams) !== canonicalProvider,
    ),
  );
  if (value !== undefined) {
    next[canonicalProvider] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function readExactProviderAuthState<T>(
  entries: Record<string, T> | undefined,
  provider: string,
): T | undefined {
  const normalizedProvider = normalizeProviderId(provider);
  return Object.entries(entries ?? {}).find(
    ([key]) => normalizeProviderId(key) === normalizedProvider,
  )?.[1];
}

function removeExactProviderAuthState<T>(
  entries: Record<string, T> | undefined,
  provider: string,
): Record<string, T> | undefined {
  const normalizedProvider = normalizeProviderId(provider);
  const next = Object.fromEntries(
    Object.entries(entries ?? {}).filter(
      ([key]) => normalizeProviderId(key) !== normalizedProvider,
    ),
  );
  return Object.keys(next).length > 0 ? next : undefined;
}

// Successful auth clears transient failure/cooldown/disable state while keeping
// unrelated metadata and updating lastUsed for round-robin ordering.
function resetSuccessfulUsageStats(
  existing: ProfileUsageStats | undefined,
  lastUsed: number,
): ProfileUsageStats {
  return {
    ...existing,
    errorCount: 0,
    blockedUntil: undefined,
    blockedReason: undefined,
    blockedSource: undefined,
    blockedModel: undefined,
    cooldownUntil: undefined,
    cooldownReason: undefined,
    cooldownClassification: undefined,
    cooldownModel: undefined,
    disabledUntil: undefined,
    disabledReason: undefined,
    failureCounts: undefined,
    lastUsed,
  };
}

function updateSuccessfulUsageStatsEntry(
  store: AuthProfileStore,
  profileId: string,
  lastUsed: number,
): void {
  store.usageStats = store.usageStats ?? {};
  store.usageStats[profileId] = resetSuccessfulUsageStats(store.usageStats[profileId], lastUsed);
}

/** Sets or clears explicit auth profile order for a provider. */
export async function setAuthProfileOrder(params: {
  agentDir?: string;
  provider: string;
  order?: string[] | null;
  expectedOrder?: string[] | null;
  expectedOrderProvider?: string;
  expectedProviderProfileIds?: string[];
  externalCli?: ExternalCliAuthDiscovery;
  authAliasLookupParams?: ProviderAuthAliasLookupParams;
}): Promise<Result<AuthProfileStore, "conflict" | "store-update-failed">> {
  const providerKey = resolveProviderIdForAuth(params.provider, params.authAliasLookupParams);
  const expectedOrderProviderKey = normalizeProviderId(
    params.expectedOrderProvider ?? params.provider,
  );
  const expectedOrderProviderProvided = Object.hasOwn(params, "expectedOrderProvider");
  const expectedOrderUsesCanonicalProvider = expectedOrderProviderKey === providerKey;
  const sanitized =
    params.order && Array.isArray(params.order) ? normalizeStringEntries(params.order) : [];
  const deduped = dedupeProfileIds(sanitized);
  const expectedOrderProvided = Object.hasOwn(params, "expectedOrder");
  const expectedOrder =
    params.expectedOrder === null
      ? null
      : dedupeProfileIds(normalizeStringEntries(params.expectedOrder));
  const expectedProviderProfileIds = params.expectedProviderProfileIds
    ? dedupeProfileIds(normalizeStringEntries(params.expectedProviderProfileIds)).toSorted()
    : undefined;
  let orderChanged = false;
  let profileMembershipChanged = false;

  const updated = await updateAuthProfileStoreWithLock({
    agentDir: params.agentDir,
    lockInheritedProfileMembership: expectedProviderProfileIds !== undefined,
    effectiveExternalCli: params.externalCli,
    // Preserve requested IDs that the agent inherits (not owns) so the local
    // save path does not prune them from the order. Without this, a secondary
    // agent's `models auth order set --agent` accepts an inherited profile ID
    // (validated against the merged store) but drops it while persisting, so
    // `order get` falls back to the inherited main order — the CLI reports a
    // switch that never happened (issue #119233). Mirrors the adjacent
    // promoteAuthProfileInOrder preservation contract; the clear-order path
    // (deduped.length === 0) must not preserve anything.
    ...(deduped.length > 0 ? { saveOptions: { preserveOrderProfileIds: deduped } } : {}),
    updater: (store, effectiveStore = store) => {
      if (expectedProviderProfileIds) {
        const currentProviderProfileIds = listProfilesForProvider(
          effectiveStore,
          providerKey,
          params.authAliasLookupParams,
        ).toSorted();
        const exactMembershipChanged =
          currentProviderProfileIds.length !== expectedProviderProfileIds.length ||
          currentProviderProfileIds.some(
            (profileId, index) => profileId !== expectedProviderProfileIds[index],
          );
        // The membership check shares the credential-store lock with the order
        // write. Otherwise a stale reorder can exclude a new login or restore a
        // profile removed while the request was in flight.
        if (exactMembershipChanged) {
          profileMembershipChanged = true;
          return false;
        }
      }
      // An explicit provider names the exact key the caller observed. When it
      // is omitted, preserve the normal alias-aware provider lookup.
      const readExpectedOrder = (candidate: AuthProfileStore) =>
        (expectedOrderProviderProvided
          ? readExactProviderAuthState(candidate.order, expectedOrderProviderKey)
          : readProviderAuthState(candidate.order, providerKey, params.authAliasLookupParams)) ??
        null;
      const localOrder = readExpectedOrder(store);
      const currentOrder = localOrder ?? readExpectedOrder(effectiveStore);
      // Compare beneath the same store lock as the write. Otherwise a login
      // promotion can be overwritten by an order built from an older snapshot.
      if (
        expectedOrderProvided &&
        (currentOrder === null || expectedOrder === null
          ? currentOrder !== expectedOrder
          : currentOrder.length !== expectedOrder.length ||
            currentOrder.some((profileId, index) => profileId !== expectedOrder[index]))
      ) {
        orderChanged = true;
        return false;
      }
      if (deduped.length === 0) {
        if (
          listProviderAuthStateEntries(store.order, providerKey, params.authAliasLookupParams)
            .length === 0
        ) {
          return false;
        }
        store.order = replaceProviderAuthState(
          store.order,
          providerKey,
          undefined,
          params.authAliasLookupParams,
        );
        return true;
      }
      if (!expectedOrderUsesCanonicalProvider) {
        store.order = removeExactProviderAuthState(store.order, expectedOrderProviderKey);
      }
      store.order = replaceProviderAuthState(
        store.order,
        providerKey,
        deduped,
        params.authAliasLookupParams,
      );
      return true;
    },
  });
  if (orderChanged || profileMembershipChanged) {
    return { ok: false, error: "conflict" };
  }
  return updated ? { ok: true, value: updated } : { ok: false, error: "store-update-failed" };
}

/** Promotes one auth profile to the front of a provider order. */
export async function promoteAuthProfileInOrder(params: {
  agentDir?: string;
  provider: string;
  profileId: string;
  createIfMissing?: boolean;
  createFromOrder?: string[];
}): Promise<AuthProfileStore | null> {
  const providerKey = resolveProviderIdForAuth(params.provider);
  return await updateAuthProfileStoreWithLock({
    agentDir: params.agentDir,
    ...(params.createFromOrder
      ? { saveOptions: { preserveOrderProfileIds: params.createFromOrder } }
      : {}),
    updater: (store) => {
      const profile = store.profiles[params.profileId];
      if (!profile || resolveProviderIdForAuth(profile.provider) !== providerKey) {
        return false;
      }
      const matchingOrderEntries = listProviderAuthStateEntries(store.order, providerKey);
      const existing = readProviderAuthState(store.order, providerKey);
      if (!existing || existing.length === 0) {
        if (!params.createIfMissing) {
          return false;
        }
        const providerProfiles = dedupeProfileIds(
          params.createFromOrder !== undefined
            ? params.createFromOrder
            : listProfilesForProvider(store, providerKey),
        );
        const next = dedupeProfileIds([
          params.profileId,
          ...providerProfiles.filter((profileId) => profileId !== params.profileId),
        ]);
        store.order = replaceProviderAuthState(store.order, providerKey, next);
        return true;
      }
      const next = dedupeProfileIds([
        params.profileId,
        ...existing.filter((profileId) => profileId !== params.profileId),
      ]);
      if (
        next.length === existing.length &&
        next.every((profileId, idx) => profileId === existing[idx]) &&
        matchingOrderEntries.length === 1 &&
        matchingOrderEntries[0]?.[0] === providerKey
      ) {
        return false;
      }
      store.order = replaceProviderAuthState(store.order, providerKey, next);
      return true;
    },
  });
}

/** Upserts an auth profile immediately into the local store. */
export function upsertAuthProfile(params: {
  profileId: string;
  credential: AuthProfileCredential;
  agentDir?: string;
}): void {
  const credential = normalizeAuthProfileCredential(params.credential);
  const store = ensureAuthProfileStoreForLocalUpdate(params.agentDir);
  store.profiles[params.profileId] = credential;
  saveAuthProfileStore(store, params.agentDir, {
    filterExternalAuthProfiles: false,
    syncExternalCli: false,
  });
}

/** Removes all auth profiles and related state for a provider. */
function removeProviderAuthProfilesFromStore(
  store: AuthProfileStore,
  provider: string,
  authAliasLookupParams?: ProviderAuthAliasLookupParams,
): boolean {
  const providerKey = resolveProviderIdForAuth(provider, authAliasLookupParams);
  const profileIds = listProfilesForProvider(store, provider, authAliasLookupParams);
  let changed = false;
  for (const profileId of profileIds) {
    if (store.profiles[profileId]) {
      delete store.profiles[profileId];
      changed = true;
    }
    if (store.usageStats?.[profileId]) {
      delete store.usageStats[profileId];
      changed = true;
    }
  }
  if (listProviderAuthStateEntries(store.order, providerKey, authAliasLookupParams).length > 0) {
    store.order = replaceProviderAuthState(
      store.order,
      providerKey,
      undefined,
      authAliasLookupParams,
    );
    changed = true;
  }
  if (listProviderAuthStateEntries(store.lastGood, providerKey, authAliasLookupParams).length > 0) {
    store.lastGood = replaceProviderAuthState(
      store.lastGood,
      providerKey,
      undefined,
      authAliasLookupParams,
    );
    changed = true;
  }
  if (store.usageStats && Object.keys(store.usageStats).length === 0) {
    store.usageStats = undefined;
  }
  return changed;
}

export async function removeProviderAuthProfilesWithLock(params: {
  provider: string;
  agentDir?: string;
  profileIds?: readonly string[];
  authAliasLookupParams?: ProviderAuthAliasLookupParams;
}): Promise<AuthProfileStore | null> {
  if (params.profileIds) {
    return await removeAuthProfilesWithLock({
      agentDir: params.agentDir,
      profileIds: params.profileIds,
    });
  }
  return await updateAuthProfileStoreWithLock({
    agentDir: params.agentDir,
    updater: (store) =>
      removeProviderAuthProfilesFromStore(store, params.provider, params.authAliasLookupParams),
  });
}

/** Removes selected auth profiles and every state pointer that references them. */
function removeAuthProfilesFromStore(
  store: AuthProfileStore,
  profileIds: ReadonlySet<string>,
): boolean {
  let changed = false;
  for (const profileId of profileIds) {
    if (store.profiles[profileId]) {
      delete store.profiles[profileId];
      changed = true;
    }
    if (store.usageStats?.[profileId]) {
      delete store.usageStats[profileId];
      changed = true;
    }
  }
  for (const [provider, order] of Object.entries(store.order ?? {})) {
    const next = order.filter((profileId) => !profileIds.has(profileId));
    if (next.length === order.length) {
      continue;
    }
    changed = true;
    if (next.length > 0) {
      store.order![provider] = next;
    } else {
      delete store.order![provider];
    }
  }
  for (const [provider, profileId] of Object.entries(store.lastGood ?? {})) {
    if (profileIds.has(profileId)) {
      delete store.lastGood![provider];
      changed = true;
    }
  }
  if (store.order && Object.keys(store.order).length === 0) {
    store.order = undefined;
  }
  if (store.lastGood && Object.keys(store.lastGood).length === 0) {
    store.lastGood = undefined;
  }
  if (store.usageStats && Object.keys(store.usageStats).length === 0) {
    store.usageStats = undefined;
  }
  return changed;
}

export async function removeAuthProfilesWithLock(params: {
  profileIds: readonly string[];
  agentDir?: string;
}): Promise<AuthProfileStore | null> {
  const profileIds = new Set(dedupeProfileIds([...params.profileIds]));
  return await updateAuthProfileStoreWithLock({
    agentDir: params.agentDir,
    updater: (store) => removeAuthProfilesFromStore(store, profileIds),
  });
}

/**
 * Removes profiles from every store that owns them. Auth profiles can be
 * adopted by a provider-specific owner agent dir, so removing only the caller's
 * store lets the profile reappear on the next status read and auth warmup.
 */
export async function removeAuthProfilesAcrossOwnerStores(params: {
  agentDir: string;
  profileIds: readonly string[];
}): Promise<boolean> {
  const profilesByOwner = new Map<string | undefined, Set<string>>();
  for (const profileId of params.profileIds) {
    const ownerAgentDir = resolvePersistedAuthProfileOwnerAgentDir({
      agentDir: params.agentDir,
      profileId,
    });
    const ownerProfiles = profilesByOwner.get(ownerAgentDir) ?? new Set<string>();
    ownerProfiles.add(profileId);
    profilesByOwner.set(ownerAgentDir, ownerProfiles);
  }
  const requesterProfiles = profilesByOwner.get(params.agentDir) ?? new Set<string>();
  for (const profileId of params.profileIds) {
    requesterProfiles.add(profileId);
  }
  profilesByOwner.set(params.agentDir, requesterProfiles);
  return updateAuthProfileStoresWithLocks({
    updates: [...profilesByOwner].map(([agentDir, profileIds], index) => ({
      agentDir,
      lockPriority: index,
      updater: (store) => removeAuthProfilesFromStore(store, profileIds),
    })),
  });
}

/** Removes a provider from every store that owns one of its selected profiles. */
export function removeProviderAuthProfilesAcrossOwnerStores(params: {
  provider: string;
  agentDir: string;
  profileIds: readonly string[];
  authAliasLookupParams?: ProviderAuthAliasLookupParams;
}): boolean {
  const ownerAgentDirs = new Set<string | undefined>();
  for (const profileId of params.profileIds) {
    ownerAgentDirs.add(
      resolvePersistedAuthProfileOwnerAgentDir({ agentDir: params.agentDir, profileId }),
    );
  }
  ownerAgentDirs.add(params.agentDir);
  return updateAuthProfileStoresWithLocks({
    updates: [...ownerAgentDirs].map((agentDir, index) => ({
      agentDir,
      lockPriority: index,
      updater: (store) =>
        removeProviderAuthProfilesFromStore(store, params.provider, params.authAliasLookupParams),
    })),
  });
}

/** Clear the last-good profile pointer for a provider under the store lock. */
export async function clearLastGoodProfileWithLock(params: {
  provider: string;
  profileId: string;
  agentDir?: string;
}): Promise<AuthProfileStore | null> {
  const providerKey = resolveProviderIdForAuth(params.provider);
  return await updateAuthProfileStoreWithLock({
    agentDir: params.agentDir,
    updater: (store) => {
      const matches = listProviderAuthStateEntries(store.lastGood, providerKey);
      if (!matches.some(([, profileId]) => profileId === params.profileId)) {
        return false;
      }
      store.lastGood = replaceProviderAuthState(store.lastGood, providerKey);
      return true;
    },
  });
}

/** Mark a profile as successfully used and update ordering/usage metadata. */
export async function markAuthProfileSuccess(params: {
  store: AuthProfileStore;
  provider: string;
  profileId: string;
  agentDir?: string;
}): Promise<void> {
  const { store, provider, profileId, agentDir } = params;
  const providerKey = resolveProviderIdForAuth(provider);
  const lastUsed = Date.now();
  const updated = await updateAuthProfileStoreWithLock({
    agentDir,
    updater: (freshStore) => {
      const profile = freshStore.profiles[profileId];
      if (!profile || resolveProviderIdForAuth(profile.provider) !== providerKey) {
        return false;
      }
      freshStore.lastGood = replaceProviderAuthState(freshStore.lastGood, providerKey, profileId);
      updateSuccessfulUsageStatsEntry(freshStore, profileId, lastUsed);
      return true;
    },
  });
  if (updated) {
    store.lastGood = updated.lastGood;
    store.usageStats = updated.usageStats;
    return;
  }
  if (updated === null) {
    authProfileProfilesLog.warn(
      "dropped auth profile bookkeeping after locked store update failed",
      {
        event: "auth_profile_bookkeeping_dropped",
        kind: "success",
        profileId,
        tags: ["auth_profiles", "persistence"],
      },
    );
  }
}
