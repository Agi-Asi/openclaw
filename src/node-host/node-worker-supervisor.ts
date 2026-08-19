import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveStateDir } from "../config/paths.js";
import type { NodeWorkerCapacitySnapshot } from "../infra/node-runner-inventory.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import {
  appendCapturedOutput,
  createCapturedOutputBuffers,
  finalizeCapturedOutput,
} from "../process/exec-output.js";
import { createChildAdapter } from "../process/supervisor/adapters/child.js";
import {
  completeWorkerLaunchDescriptor,
  parseWorkerLaunchPlan,
  type WorkerLaunchDescriptor,
} from "../worker/launch-descriptor.js";
import {
  NODE_WORKER_EXECUTION_CONTAINER_V1,
  parseNodeWorkerConnectionFailureMessage,
  parseNodeWorkerExecutionStartedMessage,
} from "../worker/node-supervisor-protocol.js";
import type {
  NodeWorkerWorkspaceRetainInput,
  NodeWorkerWorkspaceRetainResult,
} from "../worker/node-workspace-retain-protocol.js";
import { formatWorkerConnectionFailure } from "../worker/worker-connection-contract.js";
import type { WorkerConnectionEndpoint } from "../worker/worker-connection-endpoint.js";
import { NodeWorkerCapacity } from "./node-worker-capacity.js";
import {
  NODE_WORKER_CONTAINER_SHIM_FLAG,
  nodeWorkerContainerEngineFor,
  removeOwnedNodeWorkerContainers,
  resolveNodeWorkerContainerEngine,
  type NodeWorkerContainerEngine,
  type NodeWorkerContainerIdentity,
} from "./node-worker-container-runtime.js";
import { resolveNodeWorkerEntry } from "./node-worker-entry.js";
import { snapshotNodeWorkerEnv } from "./node-worker-environment.js";
import {
  NodeWorkerLaunchStore,
  type NodeWorkerLaunchReceipt,
  type NodeWorkerTerminalState,
} from "./node-worker-launch-store.js";
import { NodeWorkerMemoryProjectionRuntime } from "./node-worker-memory-projection.js";
import {
  createNodeWorkerCredentialScrubber,
  NODE_WORKER_STDERR_MAX_BYTES,
  NODE_WORKER_STDOUT_MAX_BYTES,
  parseNodeWorkerSuccessfulResult,
  sanitizeNodeWorkerDiagnostic,
  type NodeWorkerCredentialScrubber,
} from "./node-worker-output.js";
import {
  inspectNodeWorkerProcessIdentity,
  requireNodeWorkerProcessIdentity,
  type NodeWorkerProcessIdentity,
} from "./node-worker-process-identity.js";
import {
  nodeWorkerMemoryProjectionLaunchBinding,
  nodeWorkerPlanHash,
  type NodeWorkerLaunchInput,
  type NodeWorkerSupervisorIdentity,
} from "./node-worker-supervisor-contract.js";
import {
  inspectOwnedNodeWorkerTree,
  signalOwnedNodeWorkerTree,
  waitForOwnedNodeWorkerTreeDeath,
} from "./node-worker-tree-control.js";
import { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

const STOP_GRACE_MS = 1_000;
const FORCE_STOP_WAIT_MS = 4_000;
const MAX_LEASE_TIMER_DELAY_MS = 2_147_483_647;
const GATEWAY_NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const BUNDLE_HASH_PATTERN = /^[a-f0-9]{64}$/u;

type NodeWorkerContainerLaunch = {
  engine: NodeWorkerContainerEngine;
  identity: NodeWorkerContainerIdentity;
  bundleDir: string;
  relayDir: string;
  memoryDir: string;
  workspaceDir: string;
};

function resolveContainerShimArgv(): string[] {
  const currentFile = fileURLToPath(import.meta.url);
  const extension = path.extname(currentFile);
  const sourceCandidate = path.join(
    path.dirname(currentFile),
    `node-worker-container-shim${extension}`,
  );
  const installedCandidate = path.join(
    path.dirname(currentFile),
    "node-host",
    "node-worker-container-shim.js",
  );
  const entry = [sourceCandidate, installedCandidate].find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  if (!entry) {
    throw new Error("node worker container shim is unavailable in this node-host installation");
  }
  // Source-checkout node hosts run TypeScript through tsx; packaged node hosts
  // resolve the explicit stable tsdown entry above and execute plain JavaScript.
  return path.extname(entry) === ".ts"
    ? [
        process.execPath,
        "--import",
        import.meta.resolve("tsx"),
        entry,
        NODE_WORKER_CONTAINER_SHIM_FLAG,
      ]
    : [process.execPath, entry, NODE_WORKER_CONTAINER_SHIM_FLAG];
}

type ChildAdapter = Awaited<ReturnType<typeof createChildAdapter>>;
type StopState = Extract<NodeWorkerTerminalState, "cancelled" | "interrupted">;
type ActiveBase = {
  launchId: string;
  planHash: string;
  supervisor: NodeWorkerProcessIdentity;
  worker: NodeWorkerProcessIdentity | null;
};
type ActiveContainerLaunch = {
  engine: NodeWorkerContainerEngine;
  identity: NodeWorkerContainerIdentity;
  gatewayNamespace: string;
};
type ExecutionReady = {
  promise: Promise<NodeWorkerLaunchReceipt>;
  settled: boolean;
  resolve: (receipt: NodeWorkerLaunchReceipt) => void;
  reject: (error: Error) => void;
};
type ActiveChild = ActiveBase & {
  /** Pending is durable until the child attests it passed the exact start gate. */
  state: "starting" | "running";
  candidateWorker: NodeWorkerProcessIdentity;
  adapter: ChildAdapter;
  done: Promise<void>;
  executionReady: ExecutionReady;
  scrubber: NodeWorkerCredentialScrubber;
  connectionFailure: { errorText?: string };
  container?: ActiveContainerLaunch;
  leaseExpiresAtMs?: number;
  leaseTimer?: NodeJS.Timeout;
  stopState?: StopState;
};
type TerminalOutcome = Readonly<{
  state: NodeWorkerTerminalState;
  resultJson?: string;
  errorText?: string;
}>;
type ObservedTerminal = ActiveBase & {
  state: "observed";
  outcome: TerminalOutcome;
  container?: ActiveContainerLaunch;
  persistenceError?: unknown;
};
type ActiveOwnership = ActiveChild | ObservedTerminal;
type NodeWorkerSupervisorOptions = {
  bundleRoot?: string;
  env?: NodeJS.ProcessEnv;
  capacity?: number;
  capacityWaitMs?: number;
  onCapacityChanged?: (capacity: NodeWorkerCapacitySnapshot) => void;
  workspace?: NodeWorkerWorkspaceRuntime;
  memoryProjection?: NodeWorkerMemoryProjectionRuntime;
  now?: () => number;
};

function sameProcessIdentity(
  left: NodeWorkerProcessIdentity | null,
  right: NodeWorkerProcessIdentity | null,
): boolean {
  return (
    left?.pid === right?.pid &&
    left?.startTime === right?.startTime &&
    (left !== null) === (right !== null)
  );
}

function receiptMatchesOwner(
  receipt: NodeWorkerLaunchReceipt,
  supervisor: NodeWorkerProcessIdentity,
  worker: NodeWorkerProcessIdentity | null,
): boolean {
  return (
    sameProcessIdentity(receipt.supervisor, supervisor) &&
    sameProcessIdentity(receipt.worker, worker)
  );
}

function createExecutionReady(): ExecutionReady {
  let resolvePromise!: (receipt: NodeWorkerLaunchReceipt) => void;
  let rejectPromise!: (error: Error) => void;
  const executionReady: ExecutionReady = {
    settled: false,
    promise: new Promise<NodeWorkerLaunchReceipt>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    }),
    resolve: (receipt) => {
      if (!executionReady.settled) {
        executionReady.settled = true;
        resolvePromise(receipt);
      }
    },
    reject: (error) => {
      if (!executionReady.settled) {
        executionReady.settled = true;
        rejectPromise(error);
      }
    },
  };
  // The owner attaches after it opens the start gate. Avoid a pre-gate rogue
  // child acknowledgement becoming an unhandled rejection before that point.
  void executionReady.promise.catch(() => undefined);
  return executionReady;
}

async function waitForExecutionReady(
  active: ActiveChild,
  signal?: AbortSignal,
): Promise<NodeWorkerLaunchReceipt> {
  if (!signal) {
    return await active.executionReady.promise;
  }
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("node worker launch cancelled");
  }
  return await new Promise<NodeWorkerLaunchReceipt>((resolve, reject) => {
    const onAbort = () =>
      reject(
        signal.reason instanceof Error ? signal.reason : new Error("node worker launch cancelled"),
      );
    signal.addEventListener("abort", onAbort, { once: true });
    void active.executionReady.promise.then(
      (receipt) => {
        signal.removeEventListener("abort", onAbort);
        resolve(receipt);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error("node worker execution did not start"));
      },
    );
  });
}

/** Owns worker process groups, lifetime gates, and the durable node-host launch journal. */
class NodeWorkerSupervisor {
  private readonly active = new Map<string, ActiveOwnership>();
  private readonly starting = new Map<string, Promise<NodeWorkerLaunchReceipt>>();
  /** Cancels the narrow interval after durable claim but before the child is active. */
  private readonly startingAborts = new Map<string, AbortController>();
  private readonly bundleRoot: string;
  private readonly store: NodeWorkerLaunchStore;
  private readonly workerEnv: NodeJS.ProcessEnv;
  private readonly capacity: NodeWorkerCapacity;
  private readonly workspace: NodeWorkerWorkspaceRuntime;
  private memoryProjection?: NodeWorkerMemoryProjectionRuntime;
  private readonly now: () => number;
  private supervisorIdentity?: NodeWorkerProcessIdentity;
  private initializationPromise?: Promise<void>;
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(options: NodeWorkerSupervisorOptions = {}) {
    const env = options.env ?? process.env;
    this.bundleRoot = path.resolve(
      options.bundleRoot ?? path.join(resolveStateDir(env), "node-host"),
    );
    this.store = new NodeWorkerLaunchStore({ env });
    this.workerEnv = snapshotNodeWorkerEnv(env);
    this.workspace =
      options.workspace ??
      new NodeWorkerWorkspaceRuntime({ root: this.bundleRoot, env: this.workerEnv });
    this.memoryProjection = options.memoryProjection;
    this.now = options.now ?? Date.now;
    this.capacity = new NodeWorkerCapacity(this.store, options);
  }

  private requireSupervisorIdentity(): NodeWorkerProcessIdentity {
    return (this.supervisorIdentity ??= requireNodeWorkerProcessIdentity(process.pid));
  }

  private requireMemoryProjection(): NodeWorkerMemoryProjectionRuntime {
    return (this.memoryProjection ??= new NodeWorkerMemoryProjectionRuntime({
      root: this.bundleRoot,
    }));
  }

  initialize(): Promise<void> {
    return (this.initializationPromise ??= this.capacity.initialize(async (receipt) => {
      await this.recoverNonterminal(receipt, false);
    }));
  }

  async launch(
    input: NodeWorkerLaunchInput,
    connectionEndpoint: WorkerConnectionEndpoint,
    signal?: AbortSignal,
  ): Promise<NodeWorkerLaunchReceipt> {
    if (!GATEWAY_NAMESPACE_PATTERN.test(input.gatewayNamespace)) {
      throw new Error("gateway namespace must be a safe bounded path component");
    }
    if (!BUNDLE_HASH_PATTERN.test(input.expectedBundleHash)) {
      throw new Error("node worker bundle hash must be 64 lowercase hexadecimal characters");
    }
    if (!Number.isSafeInteger(input.placementGeneration) || input.placementGeneration < 0) {
      throw new Error("node worker placement generation must be a non-negative safe integer");
    }
    const plan = parseWorkerLaunchPlan(structuredClone(input.descriptor));
    const descriptor = completeWorkerLaunchDescriptor(plan, connectionEndpoint);
    if (
      descriptor.assignment.memoryReadEnforced &&
      input.execution.kind !== NODE_WORKER_EXECUTION_CONTAINER_V1
    ) {
      throw new Error("enforced memory worker requires container-v1 execution");
    }
    if (descriptor.assignment.memoryReadEnforced && !input.memoryProjection) {
      throw new Error("enforced memory worker requires an issued memory projection");
    }
    if (
      input.memoryProjection &&
      input.memoryProjection.binding.launch !==
        nodeWorkerMemoryProjectionLaunchBinding({
          ...input,
          descriptor,
        })
    ) {
      throw new Error("memory projection does not match its worker launch");
    }
    if (
      input.execution.kind === NODE_WORKER_EXECUTION_CONTAINER_V1 &&
      (descriptor.assignment.workspaceDir !== "/workspace" ||
        (descriptor.assignment.workerContainmentRoot !== undefined &&
          descriptor.assignment.workerContainmentRoot !== "/workspace"))
    ) {
      throw new Error("container worker descriptor must use the fixed /workspace root");
    }
    if (descriptor.admission.handshake.bundleHash !== input.expectedBundleHash) {
      throw new Error("node worker descriptor bundle hash does not match the launch bundle");
    }
    const planHash = nodeWorkerPlanHash(input);
    if (this.closed) {
      throw new Error("node worker supervisor is closed");
    }
    await this.initialize();
    const local = this.active.get(input.launchId);
    if (local) {
      if (local.planHash !== planHash) {
        throw new Error(`node worker launch ${input.launchId} was replayed with a different plan`);
      }
      if (local.state === "observed") {
        return await this.reconcileActiveTerminal(local);
      }
      const receipt = this.store.get(input.launchId);
      if (receipt) {
        return receipt;
      }
    }
    const supervisor = this.requireSupervisorIdentity();
    const claimInput = {
      launchId: input.launchId,
      planHash,
      gatewayNamespace: input.gatewayNamespace,
      environmentId: descriptor.admission.environmentId,
      sessionId: descriptor.admission.sessionId,
      ownerEpoch: descriptor.admission.ownerEpoch,
      placementGeneration: input.placementGeneration,
      runId: descriptor.assignment.runId,
    };
    if (this.closed) {
      throw new Error("node worker supervisor is closed");
    }
    const claim = await this.capacity.claim(claimInput, supervisor, signal);
    if (claim.action === "recover") {
      return await this.recoverNonterminal(claim.receipt);
    }
    if (claim.action === "replay") {
      const replay = this.active.get(input.launchId);
      if (replay?.planHash === planHash && replay.state === "observed") {
        return await this.reconcileActiveTerminal(replay);
      }
      const startup = this.starting.get(input.launchId);
      return startup && claim.receipt.state === "pending" ? await startup : claim.receipt;
    }
    const startupAbort = new AbortController();
    const startupSignal = signal
      ? AbortSignal.any([signal, startupAbort.signal])
      : startupAbort.signal;
    const startup = this.startClaimed({
      input,
      descriptor,
      planHash,
      supervisor,
      signal: startupSignal,
    });
    this.starting.set(input.launchId, startup);
    this.startingAborts.set(input.launchId, startupAbort);
    try {
      return await startup;
    } finally {
      if (this.starting.get(input.launchId) === startup) {
        this.starting.delete(input.launchId);
      }
      if (this.startingAborts.get(input.launchId) === startupAbort) {
        this.startingAborts.delete(input.launchId);
      }
    }
  }

  async status(launchId: string): Promise<NodeWorkerLaunchReceipt | undefined> {
    await this.initialize();
    const active = this.active.get(launchId);
    if (active?.state === "observed") {
      return await this.reconcileActiveTerminal(active);
    }
    if (active?.state === "running" && active.worker) {
      const workerState = inspectNodeWorkerProcessIdentity(active.worker);
      if (workerState === "dead" || workerState === "reused") {
        let treeState = inspectOwnedNodeWorkerTree(active.worker);
        if (treeState === "live") {
          await signalOwnedNodeWorkerTree(active.worker, "SIGTERM");
          treeState = await waitForOwnedNodeWorkerTreeDeath(active.worker, STOP_GRACE_MS);
        }
        if (treeState === "live") {
          await signalOwnedNodeWorkerTree(active.worker, "SIGKILL");
          await waitForOwnedNodeWorkerTreeDeath(active.worker, FORCE_STOP_WAIT_MS);
        }
        await active.done;
        const observed = this.active.get(launchId);
        if (observed?.state === "observed") {
          return await this.reconcileActiveTerminal(observed);
        }
      }
      return this.store.get(launchId);
    }
    const receipt = this.store.get(launchId);
    return receipt?.state === "pending" || receipt?.state === "running"
      ? await this.recoverNonterminal(receipt)
      : receipt;
  }

  async retainWorkspaces(
    input: NodeWorkerWorkspaceRetainInput,
    signal?: AbortSignal,
  ): Promise<NodeWorkerWorkspaceRetainResult> {
    await this.initialize();
    return await this.workspace.applyRetainSnapshot(
      input,
      () => this.store.listNonterminal(),
      signal,
    );
  }

  async cancel(
    expected: NodeWorkerSupervisorIdentity,
  ): Promise<NodeWorkerLaunchReceipt | undefined> {
    await this.initialize();
    const receipt = this.store.getMatching(expected);
    if (!receipt || receipt.state === "completed" || receipt.state === "failed") {
      return receipt;
    }
    if (receipt.state === "interrupted" || receipt.state === "cancelled") {
      return receipt;
    }
    const active = this.active.get(expected.launchId);
    if (active) {
      if (
        active.planHash !== expected.planHash ||
        !receiptMatchesOwner(receipt, active.supervisor, active.worker)
      ) {
        return receipt;
      }
      if (active.state !== "observed") {
        await this.stopChild(active, "cancelled");
      }
      const observed = this.active.get(expected.launchId);
      if (observed?.state === "observed") {
        return await this.reconcileActiveTerminal(observed);
      }
      return this.store.getMatching(expected);
    }
    const startup = this.starting.get(expected.launchId);
    if (startup && receipt.state === "pending" && receipt.supervisor.pid === process.pid) {
      this.startingAborts
        .get(expected.launchId)
        ?.abort(new Error("node worker launch cancelled before execution acknowledgement"));
      const cancelled = this.capacity.finishCancelled({
        expected,
        supervisor: receipt.supervisor,
        worker: null,
      });
      await startup;
      return this.store.getMatching(expected) ?? cancelled;
    }
    const supervisorState = inspectNodeWorkerProcessIdentity(receipt.supervisor);
    if (supervisorState === "live" || supervisorState === "unknown") {
      return receipt;
    }
    if (!receipt.worker) {
      return this.capacity.finishCancelled({
        expected,
        supervisor: receipt.supervisor,
        worker: null,
      });
    }
    let workerState = inspectOwnedNodeWorkerTree(receipt.worker);
    if (workerState === "unknown") {
      return receipt;
    }
    if (workerState === "live") {
      const beforeSignal = this.store.getMatching(expected);
      if (
        beforeSignal?.state !== "running" ||
        !receiptMatchesOwner(beforeSignal, receipt.supervisor, receipt.worker)
      ) {
        return beforeSignal;
      }
      await signalOwnedNodeWorkerTree(receipt.worker, "SIGTERM");
      workerState = await waitForOwnedNodeWorkerTreeDeath(receipt.worker, STOP_GRACE_MS);
    }
    if (workerState === "live") {
      const beforeSignal = this.store.getMatching(expected);
      if (
        beforeSignal?.state !== "running" ||
        !receiptMatchesOwner(beforeSignal, receipt.supervisor, receipt.worker)
      ) {
        return beforeSignal;
      }
      await signalOwnedNodeWorkerTree(receipt.worker, "SIGKILL");
      workerState = await waitForOwnedNodeWorkerTreeDeath(receipt.worker, FORCE_STOP_WAIT_MS);
    }
    if (workerState !== "dead") {
      return this.store.getMatching(expected);
    }
    await this.cleanupRecoveredContainerLaunch(receipt);
    return this.capacity.finishCancelled({
      expected,
      supervisor: receipt.supervisor,
      worker: receipt.worker,
    });
  }

  close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closed = true;
    this.capacity.close();
    for (const controller of this.startingAborts.values()) {
      controller.abort(new Error("node worker supervisor closed before execution acknowledgement"));
    }
    const operation = (async () => {
      const errors: unknown[] = [];
      if (this.initializationPromise) {
        try {
          await this.initializationPromise;
        } catch (error) {
          errors.push(error);
        }
      }
      await Promise.allSettled(this.starting.values());
      await Promise.all(
        [...this.active.values()]
          .filter((active): active is ActiveChild => active.state !== "observed")
          .map(async (active) => await this.stopChild(active, "interrupted")),
      );
      for (const active of this.active.values()) {
        if (active.state !== "observed") {
          continue;
        }
        try {
          await this.reconcileActiveTerminal(active);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, "node worker terminal reconciliation failed");
      }
    })();
    const closePromise = operation.finally(() => {
      if (this.closePromise === closePromise) {
        this.closePromise = undefined;
      }
    });
    this.closePromise = closePromise;
    return closePromise;
  }

  private async reconcileActiveTerminal(
    active: ObservedTerminal,
  ): Promise<NodeWorkerLaunchReceipt> {
    try {
      if (active.container) {
        await this.cleanupContainerLaunch(active.container);
      }
      const receipt = this.capacity.finish({
        launchId: active.launchId,
        planHash: active.planHash,
        supervisor: active.supervisor,
        worker: active.worker,
        ...active.outcome,
      });
      if (receipt.state === "pending" || receipt.state === "running") {
        throw new Error(`node worker launch ${active.launchId} terminal state was not persisted`);
      }
      if (this.active.get(active.launchId) === active) {
        this.active.delete(active.launchId);
      }
      return receipt;
    } catch (error) {
      active.persistenceError = error;
      throw error;
    }
  }

  private clearLeaseTimer(active: ActiveChild): void {
    if (active.leaseTimer) {
      clearTimeout(active.leaseTimer);
      active.leaseTimer = undefined;
    }
  }

  private armLeaseTimer(active: ActiveChild): void {
    const expiresAtMs = active.leaseExpiresAtMs;
    if (expiresAtMs === undefined) {
      return;
    }
    this.clearLeaseTimer(active);
    const remainingMs = expiresAtMs - this.now();
    if (remainingMs <= 0) {
      void this.expireLease(active);
      return;
    }
    active.leaseTimer = setTimeout(
      () => void this.expireLease(active),
      Math.min(remainingMs, MAX_LEASE_TIMER_DELAY_MS),
    );
    active.leaseTimer.unref?.();
  }

  private async expireLease(active: ActiveChild): Promise<void> {
    if (this.active.get(active.launchId) !== active || active.stopState) {
      return;
    }
    const expiresAtMs = active.leaseExpiresAtMs;
    if (expiresAtMs === undefined || expiresAtMs > this.now()) {
      this.armLeaseTimer(active);
      return;
    }
    await this.stopChild(active, "cancelled");
  }

  private async recoverNonterminal(
    receipt: NodeWorkerLaunchReceipt,
    notifyCapacity = true,
  ): Promise<NodeWorkerLaunchReceipt> {
    if (receipt.state !== "pending" && receipt.state !== "running") {
      return receipt;
    }
    const previousSupervisor = inspectNodeWorkerProcessIdentity(receipt.supervisor);
    if (previousSupervisor !== "dead" && previousSupervisor !== "reused") {
      return this.store.get(receipt.launchId) ?? receipt;
    }
    const lease = this.store.getContainerLaunchLease({
      launchId: receipt.launchId,
      planHash: receipt.planHash,
    });
    const projectionLeaseExpired = lease !== undefined && lease.expiresAtMs <= this.now();
    if (receipt.state === "pending") {
      await this.cleanupRecoveredContainerLaunch(receipt);
      return this.capacity.finish(
        {
          launchId: receipt.launchId,
          planHash: receipt.planHash,
          supervisor: receipt.supervisor,
          worker: null,
          state: projectionLeaseExpired ? "cancelled" : "interrupted",
          errorText: projectionLeaseExpired
            ? "node worker memory projection lease expired before the worker launch started"
            : "node host stopped before the worker launch started",
        },
        notifyCapacity,
      );
    }
    if (!receipt.worker) {
      return receipt;
    }
    let workerState = inspectOwnedNodeWorkerTree(receipt.worker);
    if (workerState === "unknown") {
      return this.store.get(receipt.launchId) ?? receipt;
    }
    if (workerState === "live") {
      await signalOwnedNodeWorkerTree(receipt.worker, "SIGTERM");
      workerState = await waitForOwnedNodeWorkerTreeDeath(receipt.worker, STOP_GRACE_MS);
    }
    if (workerState === "live") {
      await signalOwnedNodeWorkerTree(receipt.worker, "SIGKILL");
      workerState = await waitForOwnedNodeWorkerTreeDeath(receipt.worker, FORCE_STOP_WAIT_MS);
    }
    if (workerState !== "dead") {
      return this.store.get(receipt.launchId) ?? receipt;
    }
    await this.cleanupRecoveredContainerLaunch(receipt);
    return this.capacity.finish(
      {
        launchId: receipt.launchId,
        planHash: receipt.planHash,
        supervisor: receipt.supervisor,
        worker: receipt.worker,
        state: projectionLeaseExpired ? "cancelled" : "interrupted",
        errorText: projectionLeaseExpired
          ? "node worker memory projection lease expired during node-host recovery"
          : "node host stopped before the worker launch completed",
      },
      notifyCapacity,
    );
  }

  private async prepareContainerLaunch(params: {
    input: NodeWorkerLaunchInput;
    descriptor: WorkerLaunchDescriptor;
    planHash: string;
    entry: string;
    signal?: AbortSignal;
  }): Promise<NodeWorkerContainerLaunch> {
    params.signal?.throwIfAborted();
    const engine = await resolveNodeWorkerContainerEngine();
    params.signal?.throwIfAborted();
    if (!engine) {
      throw new Error("node host has no eligible container process-isolation runtime");
    }
    const identity = { launchId: params.input.launchId, planHash: params.planHash };
    if (!params.input.memoryProjection) {
      throw new Error("enforced node worker container launch omitted its memory projection");
    }
    // Persist cleanup ownership before preparing any local resource. A crash
    // during staging then recovers the exact engine, relay, and projection by
    // durable launch identity without persisting a descriptor or credential.
    params.signal?.throwIfAborted();
    this.store.recordContainerLaunch({
      launchId: params.input.launchId,
      planHash: params.planHash,
      engine: engine.id,
      expiresAtMs: params.input.memoryProjection.expiresAtMs,
    });
    params.signal?.throwIfAborted();
    // An interrupted launch can leave only its exact labelled container behind.
    // Reclaim that identity before staging so a retry cannot inherit another
    // turn's process or fail closed forever on Docker's global name registry.
    await removeOwnedNodeWorkerContainers(identity, engine);
    params.signal?.throwIfAborted();
    const workspaceDir = this.workspace.resolveContainerWorkspace({
      gatewayNamespace: params.input.gatewayNamespace,
      environmentId: params.descriptor.admission.environmentId,
      sessionId: params.descriptor.admission.sessionId,
      ownerEpoch: params.descriptor.admission.ownerEpoch,
    });
    const relayDir = this.workspace.resolveContainerRelayDirectory({
      gatewayNamespace: params.input.gatewayNamespace,
      ...identity,
    });
    params.signal?.throwIfAborted();
    const memoryDir = await this.requireMemoryProjection().stage({
      identity: {
        gatewayNamespace: params.input.gatewayNamespace,
        ...identity,
      },
      projection: params.input.memoryProjection,
      endpoint: params.descriptor.connectionEndpoint,
      ...(params.signal ? { signal: params.signal } : {}),
    });
    params.signal?.throwIfAborted();
    if (params.input.memoryProjection.expiresAtMs <= this.now()) {
      throw new Error("node worker memory projection lease expired before container start");
    }
    return {
      engine,
      identity,
      // `entry` has already passed the exact bundle-root and hash checks.
      bundleDir: path.dirname(params.entry),
      workspaceDir,
      relayDir,
      memoryDir,
    };
  }

  private async cleanupContainerLaunch(params: {
    engine: NodeWorkerContainerEngine;
    identity: NodeWorkerContainerIdentity;
    gatewayNamespace: string;
  }): Promise<void> {
    await removeOwnedNodeWorkerContainers(params.identity, params.engine);
    await this.workspace.removeContainerRelayDirectory({
      gatewayNamespace: params.gatewayNamespace,
      ...params.identity,
    });
    await this.requireMemoryProjection().remove({
      gatewayNamespace: params.gatewayNamespace,
      ...params.identity,
    });
  }

  private async cleanupRecoveredContainerLaunch(receipt: NodeWorkerLaunchReceipt): Promise<void> {
    const engineId = this.store.getContainerLaunchEngine({
      launchId: receipt.launchId,
      planHash: receipt.planHash,
    });
    if (!engineId) {
      return;
    }
    await this.cleanupContainerLaunch({
      engine: nodeWorkerContainerEngineFor(engineId),
      identity: { launchId: receipt.launchId, planHash: receipt.planHash },
      gatewayNamespace: receipt.gatewayNamespace,
    });
  }

  private async finishStart(params: {
    input: NodeWorkerLaunchInput;
    planHash: string;
    supervisor: NodeWorkerProcessIdentity;
    state: "cancelled" | "failed";
    errorText: string;
  }): Promise<NodeWorkerLaunchReceipt> {
    const engineId = this.store.getContainerLaunchEngine({
      launchId: params.input.launchId,
      planHash: params.planHash,
    });
    if (!engineId) {
      return this.capacity.finish({
        launchId: params.input.launchId,
        planHash: params.planHash,
        supervisor: params.supervisor,
        worker: null,
        state: params.state,
        errorText: params.errorText,
      });
    }
    const observed: ObservedTerminal = {
      state: "observed",
      launchId: params.input.launchId,
      planHash: params.planHash,
      supervisor: params.supervisor,
      worker: null,
      outcome: { state: params.state, errorText: params.errorText },
      container: {
        engine: nodeWorkerContainerEngineFor(engineId),
        identity: { launchId: params.input.launchId, planHash: params.planHash },
        gatewayNamespace: params.input.gatewayNamespace,
      },
    };
    this.active.set(observed.launchId, observed);
    return await this.reconcileActiveTerminal(observed);
  }

  private async startClaimed(params: {
    input: NodeWorkerLaunchInput;
    descriptor: WorkerLaunchDescriptor;
    planHash: string;
    supervisor: NodeWorkerProcessIdentity;
    signal?: AbortSignal;
  }): Promise<NodeWorkerLaunchReceipt> {
    const credential = params.descriptor.admission.credential;
    const endpoint = params.descriptor.connectionEndpoint;
    const cloudflareAccess = endpoint.kind === "websocket" ? endpoint.cloudflareAccess : undefined;
    const sensitiveValues = cloudflareAccess
      ? [credential, cloudflareAccess.clientId, cloudflareAccess.clientSecret]
      : [credential];
    const scrubber = createNodeWorkerCredentialScrubber(sensitiveValues);
    // Turn cancellation can beat the child's admission retry deadline. Retain the
    // producer's latest cause so the durable terminal receipt does not become generic.
    const connectionFailure: { errorText?: string } = {};
    for (const value of sensitiveValues) {
      registerSecretValueForRedaction(value);
    }
    let adapter: ChildAdapter;
    let container: NodeWorkerContainerLaunch | undefined;
    let active: ActiveChild | undefined;
    let preGateExecutionError: Error | undefined;
    const rejectExecutionReady = (error: Error) => {
      if (!active) {
        preGateExecutionError ??= error;
        return;
      }
      if (!active.executionReady.settled) {
        active.executionReady.reject(error);
        return;
      }
      // A replay after a valid acknowledgement is hostile child behavior, not a
      // harmless diagnostic. Retire the tree before it can execute more tools.
      active.connectionFailure.errorText ??= error.message;
      void this.stopChild(active, "interrupted").catch(() => undefined);
    };
    try {
      const entry = resolveNodeWorkerEntry({
        bundleRoot: this.bundleRoot,
        expectedBundleHash: params.input.expectedBundleHash,
        gatewayNamespace: params.input.gatewayNamespace,
      });
      if (params.input.execution.kind === NODE_WORKER_EXECUTION_CONTAINER_V1) {
        container = await this.prepareContainerLaunch({
          input: params.input,
          descriptor: params.descriptor,
          planHash: params.planHash,
          entry,
          ...(params.signal ? { signal: params.signal } : {}),
        });
      }
      adapter = await createChildAdapter({
        argv: container
          ? resolveContainerShimArgv()
          : [process.execPath, entry, "--internal-worker-ipc"],
        env: this.workerEnv,
        exactEnv: true,
        ownedWorker: true,
        onWorkerMessage: (message) => {
          const execution = parseNodeWorkerExecutionStartedMessage(message);
          if (execution) {
            if (
              execution.launchId !== params.input.launchId ||
              execution.planHash !== params.planHash
            ) {
              rejectExecutionReady(
                new Error(
                  "node worker execution acknowledgement did not match its launch identity",
                ),
              );
              return;
            }
            if (!active || active.state !== "starting") {
              rejectExecutionReady(new Error("node worker replayed its execution acknowledgement"));
              return;
            }
            if (this.closed || params.signal?.aborted) {
              rejectExecutionReady(
                new Error("node worker execution acknowledgement arrived after cancellation"),
              );
              return;
            }
            try {
              const running = this.store.markRunning({
                launchId: active.launchId,
                planHash: active.planHash,
                supervisor: active.supervisor,
                worker: active.candidateWorker,
              });
              if (running.state !== "running") {
                rejectExecutionReady(
                  new Error(
                    "node worker execution acknowledgement could not promote its pending launch",
                  ),
                );
                return;
              }
              // The store transition is synchronous. A terminal child event queued
              // after this handler therefore retains the durable execution fact.
              active.worker = active.candidateWorker;
              active.state = "running";
              active.executionReady.resolve(running);
            } catch (error) {
              rejectExecutionReady(
                error instanceof Error
                  ? error
                  : new Error("node worker execution acknowledgement failed"),
              );
            }
            return;
          }
          const diagnostic = parseNodeWorkerConnectionFailureMessage(message);
          if (!diagnostic) {
            return;
          }
          connectionFailure.errorText = diagnostic.cause
            ? formatWorkerConnectionFailure(
                params.descriptor.connectionEndpoint,
                sanitizeNodeWorkerDiagnostic(
                  diagnostic.cause,
                  "node worker gateway connection failed",
                  scrubber.scrub,
                ),
              )
            : undefined;
        },
        input: JSON.stringify(
          container
            ? {
                descriptor: params.descriptor,
                engine: container.engine.id,
                identity: container.identity,
                mounts: {
                  bundleDir: container.bundleDir,
                  relayDir: container.relayDir,
                  memoryDir: container.memoryDir,
                  workspaceDir: container.workspaceDir,
                },
              }
            : params.descriptor,
        ),
      });
    } catch (error) {
      const cancelled = params.signal?.aborted === true && !this.closed;
      return await this.finishStart({
        input: params.input,
        planHash: params.planHash,
        supervisor: params.supervisor,
        state: this.closed ? "interrupted" : cancelled ? "cancelled" : "failed",
        errorText: cancelled
          ? "node worker launch cancelled before process start"
          : this.closed
            ? "node host stopped before the worker launch started"
            : sanitizeNodeWorkerDiagnostic(error, "node worker spawn failed", scrubber.scrub),
      });
    }
    if (params.signal?.aborted) {
      adapter.kill("SIGKILL");
      await adapter.wait().catch(() => undefined);
      adapter.dispose();
      return await this.finishStart({
        input: params.input,
        planHash: params.planHash,
        supervisor: params.supervisor,
        state: this.closed ? "interrupted" : "cancelled",
        errorText: this.closed
          ? "node host stopped before the worker launch started"
          : "node worker launch cancelled before process start",
      });
    }
    if (!adapter.pid) {
      adapter.kill("SIGKILL");
      adapter.dispose();
      return await this.finishStart({
        input: params.input,
        planHash: params.planHash,
        supervisor: params.supervisor,
        state: "failed",
        errorText: "node worker spawn did not return a process id",
      });
    }
    let worker: NodeWorkerProcessIdentity;
    try {
      worker = requireNodeWorkerProcessIdentity(adapter.pid);
    } catch (error) {
      adapter.kill("SIGKILL");
      await adapter.wait().catch(() => undefined);
      adapter.dispose();
      return await this.finishStart({
        input: params.input,
        planHash: params.planHash,
        supervisor: params.supervisor,
        state: "failed",
        errorText: sanitizeNodeWorkerDiagnostic(
          error,
          "node worker process identity unavailable",
          scrubber.scrub,
        ),
      });
    }
    active = {
      state: "starting",
      adapter,
      done: Promise.resolve(),
      launchId: params.input.launchId,
      planHash: params.planHash,
      scrubber,
      connectionFailure,
      supervisor: params.supervisor,
      worker: null,
      candidateWorker: worker,
      executionReady: createExecutionReady(),
      ...(container
        ? {
            container: {
              engine: container.engine,
              identity: container.identity,
              gatewayNamespace: params.input.gatewayNamespace,
            },
            leaseExpiresAtMs: params.input.memoryProjection?.expiresAtMs,
          }
        : {}),
    };
    active.done = this.observeChild(active);
    this.active.set(active.launchId, active);
    void active.done.catch(() => undefined);
    if (preGateExecutionError) {
      active.executionReady.reject(preGateExecutionError);
    }
    if (params.signal?.aborted) {
      await this.stopChild(active, "cancelled");
      const cancelled = this.store.get(active.launchId);
      if (!cancelled) {
        throw new Error("cancelled node worker launch was not persisted");
      }
      return cancelled;
    }
    if (active.leaseExpiresAtMs !== undefined && active.leaseExpiresAtMs <= this.now()) {
      await this.stopChild(active, "cancelled");
      const settled = this.store.get(active.launchId);
      if (settled) {
        return settled;
      }
      throw new Error("expired node worker launch was not persisted");
    }
    if (this.closed) {
      await this.stopChild(active, "interrupted");
      const settled = this.store.get(active.launchId);
      if (settled) {
        return settled;
      }
      throw new Error("interrupted node worker launch was not persisted");
    }
    try {
      await adapter.openStartGate?.({ launchId: active.launchId, planHash: active.planHash });
      const running = await waitForExecutionReady(active, params.signal);
      if (active.leaseExpiresAtMs !== undefined) {
        this.armLeaseTimer(active);
      }
      return running;
    } catch (error) {
      const state: StopState = this.closed
        ? "interrupted"
        : params.signal?.aborted
          ? "cancelled"
          : "interrupted";
      active.executionReady.reject(
        error instanceof Error ? error : new Error("node worker execution did not become ready"),
      );
      await this.stopChild(active, state).catch(() => undefined);
      const settled = this.store.get(active.launchId);
      if (settled) {
        return settled;
      }
      throw error;
    }
  }

  private async observeChild(active: ActiveChild): Promise<void> {
    const stdout = createCapturedOutputBuffers();
    const stderr = createCapturedOutputBuffers();
    active.adapter.onStdout((chunk) =>
      appendCapturedOutput(stdout, chunk, NODE_WORKER_STDOUT_MAX_BYTES, "head"),
    );
    active.adapter.onStderr((chunk) =>
      appendCapturedOutput(
        stderr,
        chunk,
        NODE_WORKER_STDERR_MAX_BYTES + active.scrubber.maxRepresentationBytes,
        "tail",
      ),
    );
    let outcome: TerminalOutcome;
    try {
      const exit = await active.adapter.wait();
      if (active.stopState) {
        outcome = Object.freeze({
          state: active.stopState,
          errorText:
            active.connectionFailure.errorText ??
            (active.stopState === "cancelled"
              ? "node worker launch cancelled"
              : "node worker launch interrupted during node-host shutdown"),
        });
      } else if (exit.code === 0 && exit.signal === null) {
        try {
          outcome = Object.freeze({
            state: "completed",
            resultJson: parseNodeWorkerSuccessfulResult(stdout, active.scrubber.scrub),
          });
        } catch (error) {
          outcome = Object.freeze({
            state: "failed",
            errorText: sanitizeNodeWorkerDiagnostic(
              error,
              "invalid worker result",
              active.scrubber.scrub,
            ),
          });
        }
      } else {
        const detail = finalizeCapturedOutput(stderr, "tail", true).toString("utf8");
        const exitLabel = exit.signal ? `signal ${exit.signal}` : `exit code ${String(exit.code)}`;
        outcome = Object.freeze({
          state: "failed",
          errorText:
            active.connectionFailure.errorText ??
            sanitizeNodeWorkerDiagnostic(
              `node worker failed with ${exitLabel}${detail ? `: ${detail}` : ""}`,
              "node worker failed",
              active.scrubber.scrub,
            ),
        });
      }
    } catch (error) {
      outcome = Object.freeze({
        state: active.stopState ?? "failed",
        errorText:
          active.connectionFailure.errorText ??
          sanitizeNodeWorkerDiagnostic(error, "node worker wait failed", active.scrubber.scrub),
      });
    } finally {
      this.clearLeaseTimer(active);
      active.adapter.dispose();
    }
    active.executionReady.reject(new Error("node worker exited before execution became ready"));
    const observed: ObservedTerminal = {
      state: "observed",
      launchId: active.launchId,
      planHash: active.planHash,
      supervisor: active.supervisor,
      worker: active.worker,
      outcome,
      ...(active.container ? { container: active.container } : {}),
    };
    if (this.active.get(active.launchId) !== active) {
      return;
    }
    this.active.set(active.launchId, observed);
    try {
      await this.reconcileActiveTerminal(observed);
    } catch {
      // The observed outcome stays owned in memory for the next supervisor operation.
    }
  }

  private async stopChild(active: ActiveChild, state: StopState): Promise<void> {
    active.stopState ??= state;
    this.clearLeaseTimer(active);
    active.adapter.kill("SIGTERM");
    const forceKill = setTimeout(() => active.adapter.kill("SIGKILL"), STOP_GRACE_MS);
    forceKill.unref?.();
    try {
      await active.done;
    } finally {
      clearTimeout(forceKill);
    }
  }
}

export function createNodeWorkerSupervisor(
  options: NodeWorkerSupervisorOptions = {},
): NodeWorkerSupervisor {
  return new NodeWorkerSupervisor(options);
}
