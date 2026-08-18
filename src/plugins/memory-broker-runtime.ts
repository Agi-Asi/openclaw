import { startMemoryBrokerProcess, type MemoryBrokerProcess } from "../memory-broker/process.js";
import type {
  AuthorizedMemoryContentPlan,
  AuthorizedMemoryPlan,
  AuthorizedMemoryRuntime,
  AuthorizedMemoryVirtualView,
  MemoryAccessContext,
  MemoryContentAccessContext,
} from "../memory-host-sdk/host/authorization.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  startMemoryBrokerSupervisor,
  type MemoryBrokerSupervisor,
} from "./memory-broker-supervisor.js";
import type {
  MemoryPluginCapability,
  MemoryPluginVirtualViewProvider,
} from "./registry-contribution-types.js";

type BrokerRuntimeState = {
  processes: Map<string, Promise<MemoryBrokerProcess>>;
  supervisors: Set<MemoryBrokerSupervisor>;
};

const state = resolveGlobalSingleton(
  Symbol.for("openclaw.memoryBrokerRuntimeState"),
  (): BrokerRuntimeState => ({ processes: new Map(), supervisors: new Set() }),
);

type BrokeredMemoryRuntime = Readonly<AuthorizedMemoryRuntime> &
  Readonly<{ virtualView: MemoryPluginVirtualViewProvider }>;

function resolveCapabilitySnapshotId(context: MemoryAccessContext): string {
  return context.delegation?.capabilitySnapshotId ?? context.hostFactsRevision;
}

function bindingFor(context: MemoryAccessContext, policyRevision: string) {
  return Object.freeze({
    agentId: context.agentId,
    sessionId: context.sessionId,
    runId: context.runId,
    contextFingerprint: context.contextFingerprint,
    subjectRevision: context.subjectRevision,
    actorRevision: context.actor.evidenceRevision,
    capabilitySnapshotId: resolveCapabilitySnapshotId(context),
    policyRevision,
    deliveryRevision: context.delivery.deliveryRevision,
  });
}

function readExpiry(expiresAt: string): number | undefined {
  const value = Date.parse(expiresAt);
  return Number.isSafeInteger(value) && value > Date.now() ? value : undefined;
}

function authorizeExpiry(): number {
  // The selected builtin runtime currently grants a 60-second plan. Keep the bootstrap envelope
  // at or below that window so authorization cannot become a longer-lived broker capability.
  return Date.now() + 60_000;
}

async function resolveProcess(
  capability: MemoryPluginCapability,
): Promise<MemoryBrokerProcess | undefined> {
  const entry = capability.broker;
  if (!entry || entry.version !== 1 || entry.kind !== "local-child" || !entry.moduleUrl) {
    return undefined;
  }
  const existing = state.processes.get(entry.moduleUrl);
  if (existing) {
    try {
      const process = await existing;
      if (process.isRunning() && (await process.isHealthy())) {
        return process;
      }
      // A child crash retires its per-process secret and epoch. Do not reconnect or retry the
      // failed operation; discard it so a later independently authorized operation starts fresh.
      // A PID alone is not readiness: a child with a dead socket/handler must be retired too.
      await process.close().catch(() => undefined);
      if (state.processes.get(entry.moduleUrl) === existing) {
        state.processes.delete(entry.moduleUrl);
      }
    } catch {
      if (state.processes.get(entry.moduleUrl) === existing) {
        state.processes.delete(entry.moduleUrl);
      }
    }
  }
  const process = startMemoryBrokerProcess({
    brokerId: `selected-memory:${entry.moduleUrl}`,
    handlerModuleUrl: entry.moduleUrl,
  }).catch((error: unknown) => {
    state.processes.delete(entry.moduleUrl);
    throw error;
  });
  state.processes.set(entry.moduleUrl, process);
  try {
    return await process;
  } catch {
    return undefined;
  }
}

async function retireProcess(capability: MemoryPluginCapability): Promise<void> {
  const moduleUrl = capability.broker?.moduleUrl;
  if (!moduleUrl) {
    return;
  }
  const process = state.processes.get(moduleUrl);
  if (!process) {
    return;
  }
  state.processes.delete(moduleUrl);
  await (await process).close();
}

/**
 * Gateway calls this before it releases startup-gated work. The selected child is therefore a
 * readiness dependency, not a first-request side effect, and its health/replacement loop has one
 * lifetime owner instead of every brokered memory caller racing to recover it.
 */
export async function startBrokeredMemoryRuntimeSupervisor(
  capability: MemoryPluginCapability | undefined,
): Promise<MemoryBrokerSupervisor | undefined> {
  if (!capability?.broker) {
    return undefined;
  }
  const supervisor = await startMemoryBrokerSupervisor({
    ensureProcess: () => resolveProcess(capability),
    retireProcess: () => retireProcess(capability),
  });
  state.supervisors.add(supervisor);
  return Object.freeze({
    stop: async () => {
      state.supervisors.delete(supervisor);
      await supervisor.stop();
    },
  });
}

function hasPlanExpiry(plan: AuthorizedMemoryPlan): number | undefined {
  return readExpiry(plan.expiresAt);
}

/**
 * Only enforced callers select this proxy. It deliberately has no fallback to the in-process
 * plugin runtime: a missing/failed child leaves memory unavailable instead of reopening a store.
 */
export async function resolveBrokeredMemoryRuntime(
  capability: MemoryPluginCapability | undefined,
): Promise<BrokeredMemoryRuntime | undefined> {
  if (!capability) {
    return undefined;
  }
  const request = async <T>(params: Parameters<MemoryBrokerProcess["client"]["request"]>[0]) => {
    const process = await resolveProcess(capability);
    return process ? await process.client.request<T>(params) : undefined;
  };
  const authorize = async (context: MemoryAccessContext): Promise<AuthorizedMemoryPlan> => {
    const result = await request<AuthorizedMemoryPlan>({
      binding: bindingFor(context, context.hostFactsRevision),
      method: "memory.authorize",
      payload: { context },
      expiresAtMs: authorizeExpiry(),
    });
    if (!result || !hasPlanExpiry(result)) {
      throw new Error("memory broker authorization is unavailable");
    }
    return result;
  };
  const runtime = {
    authorize,
    async searchAuthorized(params: Parameters<AuthorizedMemoryRuntime["searchAuthorized"]>[0]) {
      const expiresAtMs = hasPlanExpiry(params.plan);
      if (!expiresAtMs) {
        throw new Error("memory broker search is unavailable");
      }
      const result = await request({
        binding: bindingFor(params.context, params.plan.memoryPolicyRevision),
        method: "memory.search",
        payload: {
          context: params.context,
          plan: params.plan,
          query: params.query,
          limit: params.limit,
          ...(params.sources ? { sources: params.sources } : {}),
        },
        expiresAtMs,
        ...(params.signal ? { signal: params.signal } : {}),
      });
      if (!result) {
        throw new Error("memory broker search is unavailable");
      }
      return result as Awaited<ReturnType<AuthorizedMemoryRuntime["searchAuthorized"]>>;
    },
    async readAuthorized(params: Parameters<AuthorizedMemoryRuntime["readAuthorized"]>[0]) {
      const expiresAtMs = hasPlanExpiry(params.plan);
      if (!expiresAtMs) {
        throw new Error("memory broker read is unavailable");
      }
      const result = await request({
        binding: bindingFor(params.context, params.plan.memoryPolicyRevision),
        method: "memory.read",
        payload: {
          context: params.context,
          plan: params.plan,
          handle: params.handle,
          ...(params.from !== undefined ? { from: params.from } : {}),
          ...(params.lines !== undefined ? { lines: params.lines } : {}),
        },
        expiresAtMs,
      });
      if (!result) {
        throw new Error("memory broker read is unavailable");
      }
      return result as Awaited<ReturnType<AuthorizedMemoryRuntime["readAuthorized"]>>;
    },
    async writeAuthorized(params: Parameters<AuthorizedMemoryRuntime["writeAuthorized"]>[0]) {
      const expiresAtMs = hasPlanExpiry(params.plan);
      if (!expiresAtMs) {
        throw new Error("memory broker write is unavailable");
      }
      const result = await request({
        binding: bindingFor(params.context, params.plan.memoryPolicyRevision),
        method: "memory.write",
        payload: { context: params.context, plan: params.plan, mutation: params.mutation },
        expiresAtMs,
      });
      if (!result) {
        throw new Error("memory broker write is unavailable");
      }
      return result as Awaited<ReturnType<AuthorizedMemoryRuntime["writeAuthorized"]>>;
    },
    async importAuthorized(params: Parameters<AuthorizedMemoryRuntime["importAuthorized"]>[0]) {
      const expiresAtMs = hasPlanExpiry(params.plan);
      if (!expiresAtMs) {
        throw new Error("memory broker import is unavailable");
      }
      const result = await request({
        binding: bindingFor(params.context, params.plan.memoryPolicyRevision),
        method: "memory.import",
        payload: { context: params.context, plan: params.plan, mutation: params.mutation },
        expiresAtMs,
      });
      if (!result) {
        throw new Error("memory broker import is unavailable");
      }
      return result as Awaited<ReturnType<AuthorizedMemoryRuntime["importAuthorized"]>>;
    },
    async syncAuthorized(params: Parameters<AuthorizedMemoryRuntime["syncAuthorized"]>[0]) {
      const expiresAtMs = hasPlanExpiry(params.plan);
      if (!expiresAtMs) {
        throw new Error("memory broker sync is unavailable");
      }
      const result = await request({
        binding: bindingFor(params.context, params.plan.memoryPolicyRevision),
        method: "memory.sync",
        payload: { context: params.context, plan: params.plan },
        expiresAtMs,
      });
      if (!result) {
        throw new Error("memory broker sync is unavailable");
      }
      return result as Awaited<ReturnType<AuthorizedMemoryRuntime["syncAuthorized"]>>;
    },
    async exportAuthorized(params: Parameters<AuthorizedMemoryRuntime["exportAuthorized"]>[0]) {
      const expiresAtMs = hasPlanExpiry(params.plan);
      if (!expiresAtMs) {
        throw new Error("memory broker export is unavailable");
      }
      const result = await request({
        binding: bindingFor(params.context, params.plan.memoryPolicyRevision),
        method: "memory.export",
        payload: { context: params.context, plan: params.plan, handles: params.handles },
        expiresAtMs,
      });
      if (!result) {
        throw new Error("memory broker export is unavailable");
      }
      return result as Awaited<ReturnType<AuthorizedMemoryRuntime["exportAuthorized"]>>;
    },
    async statusAuthorized(params: Parameters<AuthorizedMemoryRuntime["statusAuthorized"]>[0]) {
      const expiresAtMs = hasPlanExpiry(params.plan);
      if (!expiresAtMs) {
        throw new Error("memory broker status is unavailable");
      }
      const result = await request({
        binding: bindingFor(params.context, params.plan.memoryPolicyRevision),
        method: "memory.status",
        payload: { context: params.context, plan: params.plan },
        expiresAtMs,
      });
      if (!result) {
        throw new Error("memory broker status is unavailable");
      }
      return result as Awaited<ReturnType<AuthorizedMemoryRuntime["statusAuthorized"]>>;
    },
    async materializeAuthorizedVirtualView(params: {
      context: MemoryContentAccessContext<"read">;
      plan: AuthorizedMemoryContentPlan<"read">;
    }): Promise<AuthorizedMemoryVirtualView | undefined> {
      const expiresAtMs = hasPlanExpiry(params.plan);
      if (!expiresAtMs) {
        return undefined;
      }
      return await request<AuthorizedMemoryVirtualView>({
        binding: bindingFor(params.context, params.plan.memoryPolicyRevision),
        method: "memory.virtual-view",
        payload: { context: params.context, plan: params.plan },
        expiresAtMs,
      });
    },
    async readAuthorizedVirtualFile(
      params: Parameters<MemoryPluginVirtualViewProvider["readAuthorizedVirtualFile"]>[0],
    ) {
      const expiresAtMs = hasPlanExpiry(params.plan);
      if (!expiresAtMs) {
        throw new Error("memory broker virtual file is unavailable");
      }
      const result = await request({
        binding: bindingFor(params.context, params.plan.memoryPolicyRevision),
        method: "memory.virtual-file",
        payload: {
          context: params.context,
          plan: params.plan,
          view: params.view,
          virtualPath: params.virtualPath,
        },
        expiresAtMs,
      });
      if (!result) {
        throw new Error("memory broker virtual file is unavailable");
      }
      return result as Awaited<
        ReturnType<MemoryPluginVirtualViewProvider["readAuthorizedVirtualFile"]>
      >;
    },
  };
  return Object.freeze({
    ...runtime,
    virtualView: Object.freeze({
      materializeAuthorizedVirtualView: runtime.materializeAuthorizedVirtualView,
      readAuthorizedVirtualFile: runtime.readAuthorizedVirtualFile,
    }),
  }) as unknown as BrokeredMemoryRuntime;
}

export async function closeBrokeredMemoryRuntimes(): Promise<void> {
  const supervisors = [...state.supervisors];
  state.supervisors.clear();
  await Promise.all(supervisors.map((supervisor) => supervisor.stop()));
  const processes = [...state.processes.values()];
  state.processes.clear();
  await Promise.all(
    processes.map(async (process) => {
      try {
        await (await process).close();
      } catch {
        // Shutdown is best effort; a replacement process gets a fresh epoch and cannot reuse it.
      }
    }),
  );
}

type BrokerMaintenanceProcess = Pick<MemoryBrokerProcess, "isRunning" | "quiesce" | "resume">;

async function runBrokeredMemoryMaintenance<T>(params: {
  processes: readonly BrokerMaintenanceProcess[];
  run: () => Promise<T>;
}): Promise<T> {
  const running = params.processes.filter((process) => process.isRunning());
  const quiesced: BrokerMaintenanceProcess[] = [];
  try {
    for (const process of running) {
      await process.quiesce();
      quiesced.push(process);
    }
    return await params.run();
  } finally {
    await Promise.all(quiesced.map((process) => process.resume().catch(() => undefined)));
  }
}

/**
 * Gateway/CLI maintenance coordinates with already-running selected brokers without ever opening
 * their socket, SQLite handle, artifact root, or bootstrap credential in a worker process.
 */
export async function withBrokeredMemoryMaintenance<T>(run: () => Promise<T>): Promise<T> {
  const processes = await Promise.all([...state.processes.values()]);
  return await runBrokeredMemoryMaintenance({ processes, run });
}

export const testing = {
  runBrokeredMemoryMaintenance,
};
