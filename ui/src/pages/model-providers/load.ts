// Fetches the gateway signals behind the Models settings page.
// Each source degrades independently: a missing usage hook or an older
// gateway must not blank the provider list.
import type { SessionModelUsage } from "../../../../src/infra/session-cost-usage.types.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  ConfigSnapshot,
  ModelAuthStatusResult,
  ModelCatalogEntry,
  ModelCatalogProviderOutcome,
} from "../../api/types.ts";
import { resolveEditableSnapshotConfig } from "../../lib/config/config-state-model.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../../lib/gateway-errors.ts";
import { loadModelAuthStatus } from "../../lib/model-auth.ts";
import { loadModels } from "../../lib/model-catalog-store.ts";
import {
  requestProviderUsage,
  type ProviderUsageRequestResult,
} from "../../lib/provider-usage-request.ts";
import { requestSessionUsage } from "../../lib/sessions/index.ts";

/** Local session-spend window shown on each card. */
export const MODEL_PROVIDERS_COST_DAYS = 30;

export type ModelProvidersData = {
  authStatus: ModelAuthStatusResult | null;
  models: ModelCatalogEntry[] | null;
  providerOutcomes: ModelCatalogProviderOutcome[];
  catalogError: string | null;
  config: Record<string, unknown> | null;
  providerUsage: ProviderUsageRequestResult | null;
  costByProvider: SessionModelUsage[] | null;
  updatedAt: number | null;
  error: string | null;
};

type ModelProvidersCatalogResult = {
  providerOutcomes?: ModelCatalogProviderOutcome[];
};

export const EMPTY_MODEL_PROVIDERS_DATA: ModelProvidersData = {
  authStatus: null,
  models: null,
  providerOutcomes: [],
  catalogError: null,
  config: null,
  providerUsage: null,
  costByProvider: null,
  updatedAt: null,
  error: null,
};

function localDate(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function errorMessage(error: unknown): string {
  if (isMissingOperatorReadScopeError(error)) {
    return formatMissingOperatorReadScopeMessage("model providers");
  }
  return formatUiError(error, "request failed");
}

export async function loadModelProvidersData(
  client: GatewayBrowserClient,
  opts: {
    agentId: string;
    refresh?: boolean;
    signal?: AbortSignal;
    /**
     * Called when supplemental data (provider quota and session cost) finishes
     * loading in the background. Receives a partial update to merge into the
     * existing page state. Fixes #130111: the core provider controls are now
     * usable as soon as auth/catalog/config resolve; quota and cost update
     * independently without gating the entire page.
     */
    onSupplementalLoad?: (patch: Pick<ModelProvidersData, "providerUsage" | "costByProvider">) => void;
  },
): Promise<ModelProvidersData> {
  const request = <T>(method: string, params?: unknown): Promise<T> =>
    opts?.signal
      ? client.request<T>(method, params, { signal: opts.signal })
      : params === undefined
        ? client.request<T>(method)
        : client.request<T>(method, params);
  const catalogRefresh = opts?.refresh
    ? request<ModelProvidersCatalogResult>("models.list", {
        view: "all",
        agentId: opts.agentId,
        refresh: true,
      })
        .then((result) => ({ ok: true as const, result: result ?? null }))
        .catch((error: unknown) => ({ ok: false as const, error }))
    : Promise.resolve({ ok: true as const, result: null });
  const modelsLoad = catalogRefresh.then((catalogResult) =>
    loadModels(client, {
      agentId: opts.agentId,
      ...(opts.refresh && catalogResult.ok ? { refresh: true } : { preparedOnly: true }),
      rejectOnFailure: true,
    }).then(
      (result) => ({ ok: true as const, result }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
  );

  // Load supplemental (quota + cost) independently so they do not gate the
  // core provider controls. Start both requests immediately so they race in
  // parallel while the core await below runs.
  const providerUsagePromise = requestProviderUsage(
    client,
    opts.signal ? { signal: opts.signal } : undefined,
  );
  const costByProviderPromise = requestSessionUsage(client, {
    startDate: localDate(MODEL_PROVIDERS_COST_DAYS - 1),
    endDate: localDate(0),
    scope: "family",
    timeZone: "local",
  })
    .then((result) => result?.aggregates?.byProvider ?? null)
    .catch(() => null);

  const [authStatus, models, catalogResult, config] = await Promise.all([
    loadModelAuthStatus(client, opts).then(
      (result) => ({ ok: true as const, result }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
    modelsLoad,
    catalogRefresh,
    request<ConfigSnapshot>("config.get", {})
      .then((snapshot) => resolveEditableSnapshotConfig(snapshot))
      .catch(() => null),
  ]);

  // Fire-and-forget the supplemental load; notify the caller when it settles.
  if (opts.onSupplementalLoad) {
    const notify = opts.onSupplementalLoad;
    void Promise.all([providerUsagePromise, costByProviderPromise]).then(
      ([providerUsage, costByProvider]) => {
        notify({ providerUsage, costByProvider });
      },
      () => {
        // Individual requests already catch their own errors; this path only
        // fires if an uncaught rejection slips through — swallow it here.
      },
    );
  }

  return {
    authStatus:
      authStatus.ok && Array.isArray(authStatus.result?.providers) ? authStatus.result : null,
    models: models.ok ? models.result : null,
    providerOutcomes: catalogResult.ok ? (catalogResult.result?.providerOutcomes ?? []) : [],
    catalogError: !catalogResult.ok
      ? errorMessage(catalogResult.error)
      : !models.ok
        ? errorMessage(models.error)
        : null,
    config,
    // Supplemental data is null on the initial render; it arrives via onSupplementalLoad.
    providerUsage: null,
    costByProvider: null,
    updatedAt: Date.now(),
    // Auth status is the primary provider list; its failure is the only one
    // worth surfacing as a page-level error.
    error: authStatus.ok ? null : errorMessage(authStatus.error),
  };
}
