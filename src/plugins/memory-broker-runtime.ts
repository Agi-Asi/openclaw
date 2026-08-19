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
  agentIdsByModule: Map<string, readonly string[]>;
  unavailableAfterUpgrade: Set<string>;
  supervisors: Set<MemoryBrokerSupervisor>;
  leases: Map<string, Promise<void>>;
  maintenance: BrokerMaintenanceGate;
  closing: boolean;
};

type BrokerMaintenanceGate = {
  maintenanceTail: Promise<void>;
  maintenancePending: boolean;
  activeLifecycleOperations: number;
  idleWaiters: Set<() => void>;
};

function createBrokerMaintenanceGate(): BrokerMaintenanceGate {
  return {
    maintenanceTail: Promise.resolve(),
    maintenancePending: false,
    activeLifecycleOperations: 0,
    idleWaiters: new Set(),
  };
}

const state = resolveGlobalSingleton(
  Symbol.for("openclaw.memoryBrokerRuntimeState"),
  (): BrokerRuntimeState => ({
    processes: new Map(),
    agentIdsByModule: new Map(),
    unavailableAfterUpgrade: new Set(),
    supervisors: new Set(),
    leases: new Map(),
    maintenance: createBrokerMaintenanceGate(),
    closing: false,
  }),
);

type BrokeredMemoryRuntime = Readonly<AuthorizedMemoryRuntime> &
  Readonly<{ virtualView: MemoryPluginVirtualViewProvider }>;

function resolveCapabilitySnapshotId(context: MemoryAccessContext): string {
  return context.delegation?.capabilitySnapshotId ?? context.hostFactsRevision;
}

function actorBindingFor(context: MemoryAccessContext) {
  return context.actor.kind === "principal"
    ? Object.freeze({
        kind: "principal" as const,
        actorKind: context.actor.actorKind,
        principalId: context.actor.principalId,
      })
    : Object.freeze({
        kind: "unattributed" as const,
        transportAuditRef: context.actor.transportAuditRef,
      });
}

function bindingFor(context: MemoryAccessContext, policyRevision: string) {
  return Object.freeze({
    agentId: context.agentId,
    sessionId: context.sessionId,
    runId: context.runId,
    contextFingerprint: context.contextFingerprint,
    subjectRevision: context.subjectRevision,
    actor: actorBindingFor(context),
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

/**
 * The Gateway is the one owner allowed to change a broker's admission state. A lease covers
 * replacement and shutdown too, so no child can start or close between quiesce and resume.
 */
async function withBrokerLease<T>(
  leases: Map<string, Promise<void>>,
  moduleUrl: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = leases.get(moduleUrl) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  leases.set(moduleUrl, current);
  await previous;
  try {
    return await run();
  } finally {
    release?.();
    if (leases.get(moduleUrl) === current) {
      leases.delete(moduleUrl);
    }
  }
}

function releaseBrokerLifecycleOperation(gate: BrokerMaintenanceGate): void {
  gate.activeLifecycleOperations -= 1;
  if (gate.activeLifecycleOperations !== 0) {
    return;
  }
  for (const resolve of gate.idleWaiters) {
    resolve();
  }
  gate.idleWaiters.clear();
}

async function waitForBrokerLifecycleOperations(gate: BrokerMaintenanceGate): Promise<void> {
  while (gate.activeLifecycleOperations > 0) {
    await new Promise<void>((resolve) => gate.idleWaiters.add(resolve));
  }
}

/**
 * Resolution and replacement share a read lease. A maintenance writer blocks later lifecycle
 * work before it snapshots brokers, while already admitted work finishes before quiesce begins.
 */
async function withBrokerLifecycleOperation<T>(
  gate: BrokerMaintenanceGate,
  run: () => Promise<T>,
): Promise<T> {
  while (true) {
    const maintenanceTail = gate.maintenanceTail;
    await maintenanceTail;
    if (gate.maintenanceTail !== maintenanceTail || gate.maintenancePending) {
      continue;
    }
    gate.activeLifecycleOperations += 1;
    if (gate.maintenanceTail === maintenanceTail && !gate.maintenancePending) {
      break;
    }
    releaseBrokerLifecycleOperation(gate);
  }
  try {
    return await run();
  } finally {
    releaseBrokerLifecycleOperation(gate);
  }
}

/**
 * A tool request cannot wait behind maintenance: that would retain an agent turn until a backup
 * or repair finishes. Refuse admission before taking the reader lease so callers surface the
 * intentional memory-unavailable result while Gateway owns the writer lease.
 */
async function tryWithBrokerLifecycleOperation<T>(
  gate: BrokerMaintenanceGate,
  run: () => Promise<T>,
): Promise<T | undefined> {
  if (gate.maintenancePending) {
    return undefined;
  }
  const maintenanceTail = gate.maintenanceTail;
  gate.activeLifecycleOperations += 1;
  if (gate.maintenanceTail !== maintenanceTail || gate.maintenancePending) {
    releaseBrokerLifecycleOperation(gate);
    return undefined;
  }
  try {
    return await run();
  } finally {
    releaseBrokerLifecycleOperation(gate);
  }
}

/**
 * Gateway maintenance owns the write lease for the complete drain/mutate/resume lifecycle.
 * Marking it pending synchronously prevents a just-in-time resolver from starting a new child.
 */
async function withGatewayBrokeredMemoryMaintenanceLease<T>(
  gate: BrokerMaintenanceGate,
  run: () => Promise<T>,
): Promise<T> {
  const previous = gate.maintenanceTail;
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  gate.maintenanceTail = tail;
  gate.maintenancePending = true;
  await previous;
  await waitForBrokerLifecycleOperations(gate);
  try {
    return await run();
  } finally {
    release?.();
    if (gate.maintenanceTail === tail) {
      gate.maintenancePending = false;
    }
  }
}

function brokerModuleUrl(capability: MemoryPluginCapability): string | undefined {
  const entry = capability.broker;
  return entry?.version === 1 && entry.kind === "local-child" && entry.moduleUrl
    ? entry.moduleUrl
    : undefined;
}

async function resolveProcess(
  capability: MemoryPluginCapability,
  maintenanceBehavior: "wait" | "fail" = "wait",
): Promise<MemoryBrokerProcess | undefined> {
  const moduleUrl = brokerModuleUrl(capability);
  if (!moduleUrl) {
    return undefined;
  }
  const resolveOnLease = async () => {
    return await withBrokerLease(state.leases, moduleUrl, async () => {
      if (state.closing) {
        return undefined;
      }
      return await resolveProcessOnLease(moduleUrl);
    });
  };
  return maintenanceBehavior === "fail"
    ? await tryWithBrokerLifecycleOperation(state.maintenance, resolveOnLease)
    : await withBrokerLifecycleOperation(state.maintenance, resolveOnLease);
}

async function resolveProcessOnLease(moduleUrl: string): Promise<MemoryBrokerProcess | undefined> {
  // The Gateway may update its own package tree while it is still answering the update RPC. Do
  // not fork a child from a half-replaced tree: only the replacement Gateway may clear this fence.
  if (state.unavailableAfterUpgrade.has(moduleUrl)) {
    return undefined;
  }
  const existing = state.processes.get(moduleUrl);
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
      if (state.processes.get(moduleUrl) === existing) {
        state.processes.delete(moduleUrl);
      }
    } catch {
      if (state.processes.get(moduleUrl) === existing) {
        state.processes.delete(moduleUrl);
      }
    }
  }
  let process: Promise<MemoryBrokerProcess>;
  process = startMemoryBrokerProcess({
    brokerId: `selected-memory:${moduleUrl}`,
    handlerModuleUrl: moduleUrl,
    agentIds: state.agentIdsByModule.get(moduleUrl) ?? [],
  }).catch((error: unknown) => {
    if (state.processes.get(moduleUrl) === process) {
      state.processes.delete(moduleUrl);
    }
    throw error;
  });
  state.processes.set(moduleUrl, process);
  try {
    return await process;
  } catch {
    return undefined;
  }
}

async function retireProcess(capability: MemoryPluginCapability): Promise<void> {
  const moduleUrl = brokerModuleUrl(capability);
  if (!moduleUrl) {
    return;
  }
  await withBrokerLifecycleOperation(state.maintenance, async () => {
    await withBrokerLease(state.leases, moduleUrl, async () => {
      await retireProcessOnLease(state, moduleUrl);
    });
  });
}

async function retireProcessOnLease(
  runtimeState: BrokerRuntimeState,
  moduleUrl: string,
): Promise<void> {
  const process = runtimeState.processes.get(moduleUrl);
  if (!process) {
    return;
  }
  runtimeState.processes.delete(moduleUrl);
  await (await process).close();
}

/**
 * Gateway calls this before it releases startup-gated work. The selected child is therefore a
 * readiness dependency, not a first-request side effect, and its health/replacement loop has one
 * lifetime owner instead of every brokered memory caller racing to recover it.
 */
export async function startBrokeredMemoryRuntimeSupervisor(
  capability: MemoryPluginCapability | undefined,
  params: { agentIds?: readonly string[] } = {},
): Promise<MemoryBrokerSupervisor | undefined> {
  const moduleUrl = capability ? brokerModuleUrl(capability) : undefined;
  if (!moduleUrl) {
    return undefined;
  }
  state.agentIdsByModule.set(
    moduleUrl,
    Object.freeze([...new Set(params.agentIds ?? [])].toSorted()),
  );
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
    const process = await resolveProcess(capability, "fail");
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
        ...(params.signal ? { signal: params.signal } : {}),
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
        ...(params.signal ? { signal: params.signal } : {}),
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
        ...(params.signal ? { signal: params.signal } : {}),
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
        ...(params.signal ? { signal: params.signal } : {}),
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
        ...(params.signal ? { signal: params.signal } : {}),
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
        ...(params.signal ? { signal: params.signal } : {}),
      });
      if (!result) {
        throw new Error("memory broker status is unavailable");
      }
      return result as Awaited<ReturnType<AuthorizedMemoryRuntime["statusAuthorized"]>>;
    },
    async materializeAuthorizedVirtualView(params: {
      context: MemoryContentAccessContext<"read">;
      plan: AuthorizedMemoryContentPlan<"read">;
      signal?: AbortSignal;
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
        ...(params.signal ? { signal: params.signal } : {}),
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
        ...(params.signal ? { signal: params.signal } : {}),
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
  state.closing = true;
  try {
    // `stop()` retires through the lifecycle reader lease. Stop supervisors before taking the
    // shutdown writer so their in-flight probe cannot wait for the writer that waits for them.
    const supervisors = [...state.supervisors];
    state.supervisors.clear();
    await Promise.all(supervisors.map((supervisor) => supervisor.stop()));
    await withGatewayBrokeredMemoryMaintenanceLease(state.maintenance, async () => {
      const moduleUrls = [...state.processes.keys()].toSorted();
      await Promise.all(
        moduleUrls.map((moduleUrl) =>
          withBrokerLease(state.leases, moduleUrl, async () => {
            try {
              await retireProcessOnLease(state, moduleUrl);
            } catch {
              // Gateway shutdown still retires the map entry so a future lifecycle gets a new epoch.
            }
          }),
        ),
      );
    });
  } finally {
    state.agentIdsByModule.clear();
    state.closing = false;
  }
}

/**
 * An in-process Gateway update must retire every selected broker before it rewrites code or
 * plugins. The current process stays memory-unavailable afterward; only its replacement may
 * create a child, run startup recovery, and mint a new epoch/secret.
 */
export async function withBrokeredMemoryUpgrade<T>(run: () => Promise<T>): Promise<T> {
  return await withGatewayBrokeredMemoryMaintenanceLease(state.maintenance, async () => {
    const moduleUrls = [
      ...new Set([...state.processes.keys(), ...state.agentIdsByModule.keys()]),
    ].toSorted();
    for (const moduleUrl of moduleUrls) {
      await withBrokerLease(state.leases, moduleUrl, async () => {
        // Fence resolution before closing the old child. A failed close must abort the update;
        // proceeding could leave an old broker serving from code the update is about to replace.
        state.unavailableAfterUpgrade.add(moduleUrl);
        await retireProcessOnLease(state, moduleUrl);
      });
    }
    return await run();
  });
}

type BrokerMaintenanceProcess = Pick<MemoryBrokerProcess, "isRunning" | "quiesce" | "resume">;

async function runBrokeredMemoryMaintenance<T>(params: {
  process: BrokerMaintenanceProcess;
  run: () => Promise<T>;
  retire: () => Promise<void>;
}): Promise<T> {
  if (!params.process.isRunning()) {
    await params.retire();
    return await params.run();
  }
  try {
    await params.process.quiesce();
  } catch (error) {
    await rejectAfterBrokerRetirement(error, params.retire);
  }

  let result!: T;
  let runError: unknown;
  try {
    result = await params.run();
  } catch (error) {
    runError = error;
  }
  try {
    await params.process.resume();
  } catch (resumeError) {
    await rejectAfterBrokerRetirement(
      runError === undefined ? resumeError : new AggregateError([runError, resumeError]),
      params.retire,
    );
  }
  if (runError !== undefined) {
    throw runError;
  }
  return result;
}

async function rejectAfterBrokerRetirement(
  error: unknown,
  retire: () => Promise<void>,
): Promise<never> {
  try {
    await retire();
  } catch (retireError) {
    throw new AggregateError([error, retireError], "memory broker retirement failed");
  }
  throw error;
}

async function runBrokeredMemoryMaintenanceForModule<T>(params: {
  runtimeState: BrokerRuntimeState;
  moduleUrl: string;
  run: () => Promise<T>;
}): Promise<T> {
  return await withBrokerLease(params.runtimeState.leases, params.moduleUrl, async () => {
    const pendingProcess = params.runtimeState.processes.get(params.moduleUrl);
    if (!pendingProcess) {
      return await params.run();
    }
    const process = await pendingProcess;
    return await runBrokeredMemoryMaintenance({
      process,
      run: params.run,
      retire: () => retireProcessOnLease(params.runtimeState, params.moduleUrl),
    });
  });
}

/**
 * Gateway/CLI maintenance coordinates with already-running selected brokers without ever opening
 * their socket, SQLite handle, artifact root, or bootstrap credential in a worker process.
 */
export async function withBrokeredMemoryMaintenance<T>(run: () => Promise<T>): Promise<T> {
  return await withGatewayBrokeredMemoryMaintenanceLease(state.maintenance, async () => {
    // The snapshot happens only after the write lease excludes broker resolution/replacement.
    const moduleUrls = [...state.processes.keys()].toSorted();
    const runNext = async (index: number): Promise<T> => {
      const moduleUrl = moduleUrls[index];
      if (!moduleUrl) {
        return await run();
      }
      return await runBrokeredMemoryMaintenanceForModule({
        runtimeState: state,
        moduleUrl,
        run: () => runNext(index + 1),
      });
    };
    return await runNext(0);
  });
}

export const testing = {
  clearBrokeredMemoryUpgradeFenceForTest: () => state.unavailableAfterUpgrade.clear(),
  createBrokerMaintenanceGate,
  withBrokerLease,
  withBrokerLifecycleOperation,
  tryWithBrokerLifecycleOperation,
  withGatewayBrokeredMemoryMaintenanceLease,
  runBrokeredMemoryMaintenance,
};
