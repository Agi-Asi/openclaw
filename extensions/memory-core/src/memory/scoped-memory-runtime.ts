import { createHash, randomUUID } from "node:crypto";
import type {
  AudienceRef,
  AuthorizedMemoryPlan,
  AuthorizedMemoryReadParams,
  AuthorizedMemoryResultEnvelope,
  AuthorizedMemoryRuntime,
  AuthorizedMemorySearchParams,
  AuthorizedMemorySearchResult,
  AuthorizedResourceHandle,
  AuthorizedMemoryVirtualView,
  MemoryAccessContext,
  MemoryContentAccessContext,
} from "openclaw/plugin-sdk/memory-authorization";
import type {
  MemoryReadResult,
  MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { readScopedMemoryFtsCandidatePage } from "./scoped-memory-candidates.js";
import { withScopedMemoryDatabase } from "./scoped-memory-db.js";
import { evaluateBuiltinScopedMemoryPolicy } from "./scoped-memory-policy.js";
import { readBuiltinScopedMemoryRevisionSnapshot } from "./scoped-memory-resources.js";

const PLAN_TTL_MS = 60_000;
const MAXIMUM_CANDIDATES_PER_RESULT = 12;

type AuthorizedStore = Readonly<{
  storeId: string;
  policyRevisionId: string;
  audienceRevision: string;
}>;

type PlanState = Readonly<{
  contextFingerprint: string;
  context: MemoryContentAccessContext<"read">;
  expiresAtMs: number;
  plan: AuthorizedMemoryPlan & Readonly<{ operation: "read" }>;
  stores: readonly AuthorizedStore[];
  handles: Map<string, AuthorizedResourceHandle>;
  exposureRevision: number;
}>;

const plans = new Map<string, PlanState>();
type VirtualViewAllocation = Readonly<{
  planId: string;
  revision: string;
  expiresAtMs: number;
  /** View paths bind the exact revision selected at materialization time. */
  revisionByVirtualPath: ReadonlyMap<string, string>;
}>;

const virtualViews = new Map<string, VirtualViewAllocation>();

function pruneExpiredVirtualViews(nowMs = Date.now()): void {
  for (const [viewId, allocation] of virtualViews) {
    if (allocation.expiresAtMs <= nowMs) {
      virtualViews.delete(viewId);
    }
  }
}

function hash(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("base64url");
}

function audienceKey(audience: AudienceRef): string {
  return `${audience.kind}\0${audience.id}`;
}

function hasAudience(context: MemoryAccessContext, kind: AudienceRef["kind"], id: string): boolean {
  return context.delivery.audiences.some(
    (audience) => audience.kind === kind && audience.id === id,
  );
}

function canViewStoreAudience(params: {
  context: MemoryAccessContext;
  audienceKind: AudienceRef["kind"];
  audienceId: string;
}): boolean {
  const { context } = params;
  if (!hasAudience(context, params.audienceKind, params.audienceId)) {
    return false;
  }
  switch (params.audienceKind) {
    case "user":
      return context.subject.kind === "user" && context.subject.principalId === params.audienceId;
    case "conversation":
      return (
        context.subject.kind === "conversation" &&
        context.subject.conversationPrincipalId === params.audienceId
      );
    case "role":
      // A group sender is never its owner. Role stores require a user-scoped context and an
      // explicit role audience prepared by the host, never a latest-actor field.
      return (
        context.subject.kind === "user" &&
        context.verifiedMemberships.some((membership) => membership.groupId === params.audienceId)
      );
    case "agent-shared":
      return params.audienceId === context.agentId;
    case "agent":
      return context.delivery.sinkKind === "internal" && params.audienceId === context.agentId;
    case "internal":
      return context.delivery.sinkKind === "internal" && params.audienceId === context.agentId;
  }
}

function listAuthorizedStores(params: {
  context: MemoryContentAccessContext<"read">;
  nowMs: number;
}): readonly AuthorizedStore[] {
  return withScopedMemoryDatabase(params.context.agentId, (database) => {
    const rows = database
      .prepare(
        `SELECT store.store_id, store.audience_kind, store.audience_id,
                policy.current_revision_id, policy.revocation_epoch
           FROM memory_stores AS store
           JOIN memory_policies AS policy ON policy.policy_id = store.policy_id
           JOIN memory_storage_roots AS root ON root.storage_root_id = store.storage_root_id
          WHERE store.agent_id = ?
            AND store.lifecycle_state = 'active'
            AND policy.lifecycle_state = 'active'
            AND root.lifecycle_state = 'active'
            AND root.backend_kind = 'builtin'
          ORDER BY store.store_id`,
      )
      .all(params.context.agentId) as Array<{
      store_id: string;
      audience_kind: AudienceRef["kind"];
      audience_id: string;
      current_revision_id: string;
      revocation_epoch: number;
    }>;
    const principalIds =
      params.context.subject.kind === "user"
        ? [params.context.subject.principalId]
        : params.context.verifiedPrincipals.map((principal) => principal.principalId);
    return Object.freeze(
      rows.flatMap((row) => {
        if (
          !canViewStoreAudience({
            context: params.context,
            audienceKind: row.audience_kind,
            audienceId: row.audience_id,
          })
        ) {
          return [];
        }
        const decision = evaluateBuiltinScopedMemoryPolicy({
          agentId: params.context.agentId,
          storeId: row.store_id,
          principalIds,
          deliveryAudiences: params.context.delivery.audiences,
          operation: "read",
          nowMs: params.nowMs,
        });
        if (!decision.allowed || decision.policyRevisionId !== row.current_revision_id) {
          return [];
        }
        return [
          Object.freeze({
            storeId: row.store_id,
            policyRevisionId: row.current_revision_id,
            audienceRevision: `mar1_${hash([
              row.store_id,
              row.audience_kind,
              row.audience_id,
              row.current_revision_id,
              String(row.revocation_epoch),
            ])}`,
          }),
        ];
      }),
    );
  });
}

function deleteExpiredPlans(nowMs: number): void {
  for (const [planId, state] of plans) {
    if (state.expiresAtMs <= nowMs) {
      plans.delete(planId);
    }
  }
}

function createPlan(context: MemoryContentAccessContext<"read">): PlanState {
  const nowMs = Date.now();
  deleteExpiredPlans(nowMs);
  const stores = listAuthorizedStores({ context, nowMs });
  const expiresAtMs = nowMs + PLAN_TTL_MS;
  const planId = `mplan1_${randomUUID()}`;
  const policyRevision = `mpr1_${hash(stores.map((store) => store.policyRevisionId))}`;
  const plan = Object.freeze({
    version: 1 as const,
    planId,
    contextFingerprint: context.contextFingerprint,
    runId: context.runId,
    agentId: context.agentId,
    sessionId: context.sessionId,
    sessionIdentityRevision: context.sessionIdentityRevision,
    subjectRevision: context.subjectRevision,
    memoryPolicyRevision: policyRevision,
    deliveryRevision: context.delivery.deliveryRevision,
    operation: "read" as const,
    mounts: Object.freeze(
      stores.map((store) =>
        Object.freeze({
          version: 1 as const,
          agentId: context.agentId,
          mountHandle: `mmount1_${randomUUID()}`,
          capabilities: Object.freeze(["retrieve", "read"] as const),
          audienceRevision: store.audienceRevision,
        }),
      ),
    ),
    bootstrapResourceHandles: Object.freeze([]),
    allowedEgressAudiences: Object.freeze([...context.delivery.audiences]),
    expiresAt: new Date(expiresAtMs).toISOString(),
  }) satisfies AuthorizedMemoryPlan & Readonly<{ operation: "read" }>;
  return Object.freeze({
    contextFingerprint: context.contextFingerprint,
    context,
    expiresAtMs,
    plan,
    stores,
    handles: new Map(),
    exposureRevision: 0,
  });
}

function readPlan(params: {
  context: MemoryContentAccessContext<"read">;
  plan: AuthorizedMemoryPlan & Readonly<{ operation: "read" }>;
}): PlanState | undefined {
  const state = plans.get(params.plan.planId);
  const nowMs = Date.now();
  if (
    !state ||
    state.plan !== params.plan ||
    state.expiresAtMs <= nowMs ||
    state.contextFingerprint !== params.context.contextFingerprint ||
    state.context.agentId !== params.context.agentId ||
    state.context.sessionId !== params.context.sessionId ||
    state.context.sessionIdentityRevision !== params.context.sessionIdentityRevision ||
    state.context.subjectRevision !== params.context.subjectRevision ||
    state.context.delivery.deliveryRevision !== params.context.delivery.deliveryRevision ||
    state.context.delivery.egressRegistryRevision !==
      params.context.delivery.egressRegistryRevision ||
    [...state.context.delivery.audiences].map(audienceKey).toSorted().join("\0") !==
      [...params.context.delivery.audiences].map(audienceKey).toSorted().join("\0")
  ) {
    return undefined;
  }
  const currentStores = listAuthorizedStores({ context: params.context, nowMs });
  if (
    currentStores.length !== state.stores.length ||
    currentStores.some(
      (store, index) =>
        store.storeId !== state.stores[index]?.storeId ||
        store.policyRevisionId !== state.stores[index]?.policyRevisionId,
    )
  ) {
    return undefined;
  }
  return state;
}

function materializeAuthorizedVirtualView(params: {
  context: MemoryContentAccessContext<"read">;
  plan: AuthorizedMemoryPlan & Readonly<{ operation: "read" }>;
}): AuthorizedMemoryVirtualView | undefined {
  pruneExpiredVirtualViews();
  const state = readPlan(params);
  if (!state || state.stores.length !== state.plan.mounts.length) {
    return undefined;
  }
  const revision = `mviewr1_${hash(state.stores.map((store) => store.policyRevisionId))}`;
  const roots = state.stores.map((_, index) =>
    Object.freeze({
      version: 1 as const,
      mountHandle: state.plan.mounts[index]!.mountHandle,
      virtualRoot: `projections-${index + 1}`,
      access: "read" as const,
    }),
  );
  const revisionByVirtualPath = new Map<string, string>();
  const files = state.stores.flatMap((store, index) => {
    const root = roots[index]!;
    const rows = withScopedMemoryDatabase(
      params.context.agentId,
      (database) =>
        database
          .prepare(
            `SELECT revision.revision_id
             FROM memory_resources AS resource
             JOIN memory_resource_revisions AS revision
               ON revision.resource_id = resource.resource_id
             WHERE resource.agent_id = ?
               AND resource.store_id = ?
               AND revision.lifecycle_state = 'active'
               AND (revision.expires_at IS NULL OR revision.expires_at > ?)
             ORDER BY resource.resource_id`,
          )
          .all(params.context.agentId, store.storeId, Date.now()) as Array<{
          revision_id: string;
        }>,
    );
    return rows.flatMap((row, ordinal) => {
      const virtualPath = `${root.virtualRoot}/${ordinal + 1}.md`;
      revisionByVirtualPath.set(virtualPath, row.revision_id);
      return [
        Object.freeze({
          version: 1 as const,
          mountHandle: root.mountHandle,
          virtualPath,
        }),
      ];
    });
  });
  const view = Object.freeze({
    version: 1 as const,
    viewId: `mview1_${randomUUID()}`,
    planId: state.plan.planId,
    contextFingerprint: state.contextFingerprint,
    revision,
    roots: Object.freeze(roots),
    files: Object.freeze(files),
    expiresAt: state.plan.expiresAt,
  });
  virtualViews.set(
    view.viewId,
    Object.freeze({
      planId: view.planId,
      revision: view.revision,
      expiresAtMs: state.expiresAtMs,
      revisionByVirtualPath,
    }),
  );
  return view;
}

function readAuthorizedVirtualFile(params: {
  context: MemoryContentAccessContext<"read">;
  plan: AuthorizedMemoryPlan & Readonly<{ operation: "read" }>;
  view: AuthorizedMemoryVirtualView;
  virtualPath: string;
}): AuthorizedMemoryResultEnvelope<MemoryReadResult> {
  pruneExpiredVirtualViews();
  const state = readPlan(params);
  const allocation = virtualViews.get(params.view.viewId);
  const normalized = params.virtualPath.normalize("NFC");
  const parts = normalized.split("/");
  const revisionId = allocation?.revisionByVirtualPath.get(normalized);
  if (
    !state ||
    !allocation ||
    allocation.expiresAtMs <= Date.now() ||
    allocation.planId !== params.plan.planId ||
    allocation.revision !== params.view.revision ||
    params.view.planId !== params.plan.planId ||
    params.view.contextFingerprint !== params.context.contextFingerprint ||
    normalized !== params.virtualPath ||
    parts.length !== 2 ||
    !revisionId
  ) {
    throw new Error("authorized memory virtual view is unavailable");
  }
  const snapshot = readBuiltinScopedMemoryRevisionSnapshot({
    agentId: params.context.agentId,
    storeIds: state.stores.map((store) => store.storeId),
    revisionId,
  });
  if (!snapshot) {
    throw new Error("authorized memory virtual view is unavailable");
  }
  return createEnvelope({
    state,
    context: params.context,
    value: Object.freeze({
      text: snapshot.content,
      path: `memory/${snapshot.logicalLocator}`,
      from: 1,
      lines: snapshot.content.split("\n").length,
    }),
    revisions: [snapshot.revisionId],
    sourcePolicySetIds: [`mps1_${snapshot.policyRevisionId}`],
  });
}

function createHandle(params: {
  plan: PlanState;
  revisionId: string;
  policyRevision: string;
}): AuthorizedResourceHandle {
  const handle = Object.freeze({
    version: 1 as const,
    handleId: `mhandle1_${randomUUID()}`,
    planId: params.plan.plan.planId,
    contextFingerprint: params.plan.contextFingerprint,
    resourceRevision: params.revisionId,
    policyRevision: params.policyRevision,
    expiresAt: params.plan.plan.expiresAt,
  });
  params.plan.handles.set(handle.handleId, handle);
  return handle;
}

function createEnvelope<T>(params: {
  state: PlanState;
  context: MemoryContentAccessContext<"read">;
  value: T;
  revisions: readonly string[];
  sourcePolicySetIds: readonly string[];
}): AuthorizedMemoryResultEnvelope<T> {
  const exposureRevision = params.state.exposureRevision + 1;
  const sourcePolicySetId = `mpset1_${hash(params.sourcePolicySetIds.toSorted())}`;
  const recordedAt = new Date().toISOString();
  const value = Object.freeze({
    version: 1 as const,
    value: params.value,
    exposureReceipt: Object.freeze({
      version: 1 as const,
      receiptId: `mexp1_${randomUUID()}`,
      contextFingerprint: params.context.contextFingerprint,
      planId: params.state.plan.planId,
      runId: params.context.runId,
      runExposureRevision: `mrun1_${exposureRevision}`,
      sourcePolicySetId,
      exposedRevisionHandles: Object.freeze([...new Set(params.revisions)].toSorted()),
      recordedAt,
    }),
    egressReceipt: Object.freeze({
      version: 1 as const,
      receiptId: `megr1_${randomUUID()}`,
      contextFingerprint: params.context.contextFingerprint,
      planId: params.state.plan.planId,
      runId: params.context.runId,
      runExposureRevision: `mrun1_${exposureRevision}`,
      sourcePolicySetId,
      allowedAudiences: Object.freeze([...params.context.delivery.audiences]),
      deliveryRevision: params.context.delivery.deliveryRevision,
      egressRegistryRevision: params.context.delivery.egressRegistryRevision,
      expiresAt: params.state.plan.expiresAt,
    }),
  }) as AuthorizedMemoryResultEnvelope<T>;
  plans.set(params.state.plan.planId, Object.freeze({ ...params.state, exposureRevision }));
  return value;
}

function toSearchResult(params: {
  candidate: { score: number; textScore?: number; vectorScore?: number };
  snapshot: ReturnType<typeof readBuiltinScopedMemoryRevisionSnapshot>;
  handle: AuthorizedResourceHandle;
}): AuthorizedMemorySearchResult | undefined {
  const snapshot = params.snapshot;
  if (!snapshot) {
    return undefined;
  }
  const snippet = snapshot.content.split("\n", 1)[0]?.trim() ?? "";
  if (!snippet) {
    return undefined;
  }
  return Object.freeze({
    path: `memory/${snapshot.logicalLocator}`,
    startLine: 1,
    endLine: Math.max(1, snapshot.content.split("\n").length),
    score: params.candidate.score,
    ...(params.candidate.vectorScore !== undefined
      ? { vectorScore: params.candidate.vectorScore }
      : {}),
    ...(params.candidate.textScore !== undefined ? { textScore: params.candidate.textScore } : {}),
    snippet,
    source: snapshot.source,
    resourceHandle: params.handle,
  });
}

const builtinScopedMemoryReadRuntime = {
  async authorize(
    context: MemoryAccessContext,
  ): Promise<AuthorizedMemoryPlan & Readonly<{ operation: "read" }>> {
    if (context.operation !== "read") {
      throw new Error("builtin scoped memory only supports read authorization in Phase 1C");
    }
    const state = createPlan(context as MemoryContentAccessContext<"read">);
    plans.set(state.plan.planId, state);
    return state.plan;
  },

  async searchAuthorized(
    params: AuthorizedMemorySearchParams<"read">,
  ): Promise<AuthorizedMemoryResultEnvelope<readonly AuthorizedMemorySearchResult[]>> {
    const state = readPlan(params);
    if (!state || !params.query.trim()) {
      throw new Error("authorized memory search is unavailable");
    }
    const limit = Math.max(1, Math.min(100, Math.trunc(params.limit)));
    const storeIds = state.stores.map((store) => store.storeId);
    const sources = params.sources?.length ? params.sources : (["memory", "sessions"] as const);
    const candidates = withScopedMemoryDatabase(params.context.agentId, (database) =>
      readScopedMemoryFtsCandidatePage({
        database,
        query: params.query,
        storeIds,
        sources: sources as readonly MemorySource[],
        limit: limit * MAXIMUM_CANDIDATES_PER_RESULT,
        offset: 0,
      }),
    );
    const results: AuthorizedMemorySearchResult[] = [];
    const sourcePolicySetIds: string[] = [];
    for (const candidate of candidates) {
      if (results.length >= limit) {
        break;
      }
      const snapshot = readBuiltinScopedMemoryRevisionSnapshot({
        agentId: params.context.agentId,
        storeIds,
        revisionId: candidate.revisionId,
      });
      if (!snapshot) {
        continue;
      }
      const handle = createHandle({
        plan: state,
        revisionId: snapshot.revisionId,
        policyRevision: snapshot.policyRevisionId,
      });
      const result = toSearchResult({ candidate, snapshot, handle });
      if (!result) {
        continue;
      }
      results.push(result);
      sourcePolicySetIds.push(`mps1_${snapshot.policyRevisionId}`);
    }
    return createEnvelope({
      state,
      context: params.context,
      value: Object.freeze(results),
      revisions: results.map((result) => result.resourceHandle.resourceRevision),
      sourcePolicySetIds:
        sourcePolicySetIds.length > 0 ? sourcePolicySetIds : [state.plan.memoryPolicyRevision],
    });
  },

  async readAuthorized(
    params: AuthorizedMemoryReadParams<"read">,
  ): Promise<AuthorizedMemoryResultEnvelope<MemoryReadResult>> {
    const state = readPlan(params);
    const storedHandle = state?.handles.get(params.handle.handleId);
    if (
      !state ||
      !storedHandle ||
      storedHandle.planId !== params.handle.planId ||
      storedHandle.contextFingerprint !== params.handle.contextFingerprint ||
      storedHandle.resourceRevision !== params.handle.resourceRevision ||
      storedHandle.policyRevision !== params.handle.policyRevision ||
      storedHandle.expiresAt !== params.handle.expiresAt
    ) {
      throw new Error("authorized memory read is unavailable");
    }
    const snapshot = readBuiltinScopedMemoryRevisionSnapshot({
      agentId: params.context.agentId,
      storeIds: state.stores.map((store) => store.storeId),
      revisionId: storedHandle.resourceRevision,
    });
    if (!snapshot || snapshot.policyRevisionId !== storedHandle.policyRevision) {
      throw new Error("authorized memory read is unavailable");
    }
    const lines = snapshot.content.split("\n");
    const from = Math.max(1, Math.trunc(params.from ?? 1));
    const lineCount = Math.max(1, Math.min(1000, Math.trunc(params.lines ?? 200)));
    const selected = lines.slice(from - 1, from - 1 + lineCount);
    const value: MemoryReadResult = Object.freeze({
      text: selected.join("\n"),
      path: `memory/${snapshot.logicalLocator}`,
      from,
      lines: selected.length,
      ...(from - 1 + selected.length < lines.length
        ? { truncated: true, nextFrom: from + selected.length }
        : {}),
    });
    return createEnvelope({
      state,
      context: params.context,
      value,
      revisions: [snapshot.revisionId],
      sourcePolicySetIds: [`mps1_${snapshot.policyRevisionId}`],
    });
  },
};

// Phase 1C intentionally supplies only content reads. The SDK includes derive overloads for
// later phases, so retain the runtime-shaped facade while the implementation rejects them above.
export const builtinScopedMemoryAuthorizedRuntime = Object.freeze(
  builtinScopedMemoryReadRuntime,
) as unknown as Pick<AuthorizedMemoryRuntime, "authorize" | "searchAuthorized" | "readAuthorized">;

export const builtinScopedMemoryVirtualView = Object.freeze({
  async materializeAuthorizedVirtualView(params: {
    context: MemoryContentAccessContext<"read">;
    plan: AuthorizedMemoryPlan & Readonly<{ operation: "read" }>;
  }): Promise<AuthorizedMemoryVirtualView | undefined> {
    return materializeAuthorizedVirtualView(params);
  },
  async readAuthorizedVirtualFile(params: {
    context: MemoryContentAccessContext<"read">;
    plan: AuthorizedMemoryPlan & Readonly<{ operation: "read" }>;
    view: AuthorizedMemoryVirtualView;
    virtualPath: string;
  }): Promise<AuthorizedMemoryResultEnvelope<MemoryReadResult>> {
    return readAuthorizedVirtualFile(params);
  },
});

export function resetBuiltinScopedMemoryAuthorizedRuntimeForTest(): void {
  plans.clear();
  virtualViews.clear();
}
