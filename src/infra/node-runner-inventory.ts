import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { validateWorkerAdmissionHandshake } from "../../packages/gateway-protocol/src/index.js";
import { WORKER_BUNDLE_PREWARM_VERSION } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { NODE_WORKER_EXECUTION_CONTAINER_V1 } from "../worker/node-supervisor-protocol.js";

export const NODE_RUNNER_INVENTORY_UPDATE_METHOD = "node.runnerInventory.update";
export const NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE = "node-worker-supervisor-v5";
export const NODE_WORKER_SUPERVISOR_PROCESS_ISOLATION_PROTOCOL_FEATURE =
  "node-worker-supervisor-v6";
export const NODE_WORKER_SUPERVISOR_MEMORY_PROJECTION_PROTOCOL_FEATURE =
  "node-worker-supervisor-v7";
export const NODE_WORKER_SUPERVISOR_BINARY_CAPACITY_PROTOCOL_FEATURE = "node-worker-supervisor-v4";
export const NODE_WORKER_SUPERVISOR_EXECUTION_CONTEXT_V1_PROTOCOL_FEATURE =
  "node-worker-supervisor-v3";
export const NODE_WORKER_SUPERVISOR_BUILD_PROTOCOL_FEATURE = "node-worker-supervisor-v2";
export const NODE_WORKER_SUPERVISOR_LEGACY_PROTOCOL_FEATURE = "node-worker-supervisor-v1";
export const NODE_WORKER_BUNDLE_RETENTION_VERSION = 1;
export const NODE_WORKER_BUNDLE_STATUS_VERSION = 1;
export const NODE_WORKER_CAPACITY_MAX = 1_024;

export const NODE_RUNNER_UPDATE_REQUIRED_ISSUE = {
  code: "update-required",
  action: "update-and-reconnect",
  updateCommand: "openclaw update",
  headlessReconnectCommand: "openclaw node restart",
} as const;

export type NodeRunnerInventoryIssue = typeof NODE_RUNNER_UPDATE_REQUIRED_ISSUE;
export type NodeWorkerCapacitySnapshot = Readonly<{
  total: number;
  available: number;
}>;
export type NodeWorkerProcessIsolationDeclaration = Readonly<{
  kind: typeof NODE_WORKER_EXECUTION_CONTAINER_V1;
  memoryProjection?: 1;
}>;

export type NodeWorkerHostDeclaration =
  | { enabled: false }
  | {
      enabled: true;
      capacity: NodeWorkerCapacitySnapshot;
      bundlePrewarm?: typeof WORKER_BUNDLE_PREWARM_VERSION;
      bundleRetention?: typeof NODE_WORKER_BUNDLE_RETENTION_VERSION;
      bundleStatus?: typeof NODE_WORKER_BUNDLE_STATUS_VERSION;
      /** Present only on v6 hosts that passed the local container-runtime gate. */
      processIsolation?: NodeWorkerProcessIsolationDeclaration;
    };

export type NodeRunnerInventoryDeclaration =
  | { protocolFeatures: readonly [] }
  | {
      protocolFeatures: readonly [
        | typeof NODE_WORKER_SUPERVISOR_LEGACY_PROTOCOL_FEATURE
        | typeof NODE_WORKER_SUPERVISOR_BUILD_PROTOCOL_FEATURE
        | typeof NODE_WORKER_SUPERVISOR_EXECUTION_CONTEXT_V1_PROTOCOL_FEATURE
        | typeof NODE_WORKER_SUPERVISOR_BINARY_CAPACITY_PROTOCOL_FEATURE,
      ];
    }
  | {
      protocolFeatures: readonly [
        | typeof NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE
        | typeof NODE_WORKER_SUPERVISOR_PROCESS_ISOLATION_PROTOCOL_FEATURE
        | typeof NODE_WORKER_SUPERVISOR_MEMORY_PROJECTION_PROTOCOL_FEATURE,
      ];
      workerHost: NodeWorkerHostDeclaration;
    };

function parseCapacitySnapshot(value: unknown): NodeWorkerCapacitySnapshot | null {
  if (!isRecord(value)) {
    return null;
  }
  const keys = Object.keys(value);
  const total = value.total;
  const available = value.available;
  return keys.length === 2 &&
    keys.includes("total") &&
    keys.includes("available") &&
    typeof total === "number" &&
    typeof available === "number" &&
    Number.isSafeInteger(total) &&
    Number.isSafeInteger(available) &&
    total >= 1 &&
    total <= NODE_WORKER_CAPACITY_MAX &&
    available >= 0 &&
    available <= total
    ? { total, available }
    : null;
}

function parseProcessIsolationDeclaration(
  value: unknown,
  requireMemoryProjection: boolean,
): NodeWorkerProcessIsolationDeclaration | null {
  if (
    !isRecord(value) ||
    !Object.hasOwn(value, "kind") ||
    value.kind !== NODE_WORKER_EXECUTION_CONTAINER_V1 ||
    (requireMemoryProjection
      ? Object.keys(value).length !== 2 || value.memoryProjection !== 1
      : Object.keys(value).length !== 1)
  ) {
    return null;
  }
  return requireMemoryProjection
    ? { kind: NODE_WORKER_EXECUTION_CONTAINER_V1, memoryProjection: 1 }
    : { kind: NODE_WORKER_EXECUTION_CONTAINER_V1 };
}

function parseWorkerHostDeclaration(params: {
  value: unknown;
  requireProcessIsolation: boolean;
  requireMemoryProjection?: boolean;
}): NodeWorkerHostDeclaration | null {
  const { value } = params;
  if (!isRecord(value) || typeof value.enabled !== "boolean") {
    return null;
  }
  const keys = Object.keys(value);
  if (!value.enabled) {
    return !params.requireProcessIsolation && keys.length === 1 && keys[0] === "enabled"
      ? { enabled: false }
      : null;
  }
  const capacity = parseCapacitySnapshot(value.capacity);
  const processIsolation =
    value.processIsolation === undefined
      ? undefined
      : parseProcessIsolationDeclaration(
          value.processIsolation,
          params.requireMemoryProjection === true,
        );
  if (
    !capacity ||
    keys.length < 2 ||
    keys.length > 6 ||
    !keys.includes("enabled") ||
    !keys.includes("capacity") ||
    keys.some(
      (key) =>
        key !== "enabled" &&
        key !== "capacity" &&
        key !== "bundlePrewarm" &&
        key !== "bundleRetention" &&
        key !== "bundleStatus" &&
        key !== "processIsolation",
    ) ||
    (value.bundlePrewarm !== undefined && value.bundlePrewarm !== WORKER_BUNDLE_PREWARM_VERSION) ||
    (value.bundleRetention !== undefined &&
      value.bundleRetention !== NODE_WORKER_BUNDLE_RETENTION_VERSION) ||
    (value.bundleStatus !== undefined &&
      value.bundleStatus !== NODE_WORKER_BUNDLE_STATUS_VERSION) ||
    (value.bundleStatus !== undefined && value.bundleRetention === undefined) ||
    (value.processIsolation !== undefined && !processIsolation) ||
    (params.requireProcessIsolation !== Boolean(processIsolation))
  ) {
    return null;
  }
  return {
    enabled: true,
    capacity,
    ...(value.bundlePrewarm === WORKER_BUNDLE_PREWARM_VERSION
      ? { bundlePrewarm: WORKER_BUNDLE_PREWARM_VERSION }
      : {}),
    ...(value.bundleRetention === NODE_WORKER_BUNDLE_RETENTION_VERSION
      ? { bundleRetention: NODE_WORKER_BUNDLE_RETENTION_VERSION }
      : {}),
    ...(value.bundleStatus === NODE_WORKER_BUNDLE_STATUS_VERSION
      ? { bundleStatus: NODE_WORKER_BUNDLE_STATUS_VERSION }
      : {}),
    ...(processIsolation ? { processIsolation } : {}),
  };
}

function isBinaryCapacityWorkerHostDeclaration(value: unknown): boolean {
  if (!isRecord(value) || typeof value.enabled !== "boolean") {
    return false;
  }
  const keys = Object.keys(value);
  if (!value.enabled) {
    return keys.length === 1 && keys[0] === "enabled";
  }
  return (
    keys.length >= 2 &&
    keys.length <= 5 &&
    keys.includes("enabled") &&
    keys.includes("capacity") &&
    keys.every(
      (key) =>
        key === "enabled" ||
        key === "capacity" ||
        key === "bundlePrewarm" ||
        key === "bundleRetention" ||
        key === "bundleStatus",
    ) &&
    (value.capacity === "available" || value.capacity === "full") &&
    (value.bundlePrewarm === undefined || value.bundlePrewarm === WORKER_BUNDLE_PREWARM_VERSION) &&
    (value.bundleRetention === undefined ||
      value.bundleRetention === NODE_WORKER_BUNDLE_RETENTION_VERSION) &&
    (value.bundleStatus === undefined ||
      value.bundleStatus === NODE_WORKER_BUNDLE_STATUS_VERSION) &&
    (value.bundleStatus === undefined || value.bundleRetention !== undefined)
  );
}

/** Parses the closed reconnect-scoped node-host runner declaration. */
export function parseNodeRunnerInventoryDeclaration(
  value: unknown,
): NodeRunnerInventoryDeclaration | null {
  if (!isRecord(value) || !Array.isArray(value.protocolFeatures)) {
    return null;
  }
  const keys = Object.keys(value);
  if (value.protocolFeatures.length === 0) {
    return keys.length === 1 && keys.includes("protocolFeatures") ? { protocolFeatures: [] } : null;
  }
  if (value.protocolFeatures.length !== 1) {
    return null;
  }
  const feature = value.protocolFeatures[0];
  if (
    feature === NODE_WORKER_SUPERVISOR_LEGACY_PROTOCOL_FEATURE ||
    feature === NODE_WORKER_SUPERVISOR_BUILD_PROTOCOL_FEATURE
  ) {
    if (
      keys.length < 1 ||
      keys.length > 2 ||
      keys.some((key) => key !== "protocolFeatures" && key !== "workerRuns") ||
      (value.workerRuns !== undefined && !validateWorkerAdmissionHandshake(value.workerRuns))
    ) {
      return null;
    }
    // v1/v2 carried the node-local package build in inventory. Keep wire
    // validation only so shipped nodes receive the explicit update path.
    return { protocolFeatures: [feature] };
  }
  if (
    feature === NODE_WORKER_SUPERVISOR_EXECUTION_CONTEXT_V1_PROTOCOL_FEATURE ||
    feature === NODE_WORKER_SUPERVISOR_BINARY_CAPACITY_PROTOCOL_FEATURE
  ) {
    return keys.length === 2 && isBinaryCapacityWorkerHostDeclaration(value.workerHost)
      ? { protocolFeatures: [feature] }
      : null;
  }
  if (
    (feature !== NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE &&
      feature !== NODE_WORKER_SUPERVISOR_PROCESS_ISOLATION_PROTOCOL_FEATURE &&
      feature !== NODE_WORKER_SUPERVISOR_MEMORY_PROJECTION_PROTOCOL_FEATURE) ||
    keys.length !== 2
  ) {
    return null;
  }
  const workerHost = parseWorkerHostDeclaration({
    value: value.workerHost,
    requireProcessIsolation:
      feature === NODE_WORKER_SUPERVISOR_PROCESS_ISOLATION_PROTOCOL_FEATURE ||
      feature === NODE_WORKER_SUPERVISOR_MEMORY_PROJECTION_PROTOCOL_FEATURE,
    requireMemoryProjection: feature === NODE_WORKER_SUPERVISOR_MEMORY_PROJECTION_PROTOCOL_FEATURE,
  });
  return workerHost
    ? { protocolFeatures: [feature], workerHost }
    : null;
}

export function formatNodeRunnerUpdateRequired(
  nodeId: string,
  issue: NodeRunnerInventoryIssue,
): string {
  return `device worker node ${nodeId} requires an update before it can host sessions; run ${issue.updateCommand}, then reconnect it (for a headless node, run ${issue.headlessReconnectCommand})`;
}
