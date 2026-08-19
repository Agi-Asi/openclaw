import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { parseWorkerLaunchPlan, type WorkerLaunchPlan } from "./launch-descriptor.js";
import {
  parseNodeWorkerMemoryProjection,
  type NodeWorkerMemoryProjection,
} from "./node-memory-projection-protocol.js";

const IDENTIFIER_MAX_CHARS = 256;
const GATEWAY_NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const NODE_WORKER_SUPERVISOR_CANCEL_REQUEST_MAX_BYTES = 4 * 1024;
const NODE_WORKER_RESULT_JSON_MAX_BYTES = 64 * 1024;
const NODE_WORKER_ERROR_TEXT_MAX_BYTES = 4 * 1024;
const NODE_WORKER_CONNECTION_FAILURE_CAUSE_MAX_BYTES = 64 * 1024;
export const NODE_WORKER_CONNECTION_FAILURE_MESSAGE_TYPE = "openclaw-worker-connection-failure-v1";
export const NODE_WORKER_EXECUTION_STARTED_MESSAGE_TYPE = "openclaw-worker-execution-started-v1";
export const NODE_WORKER_EXECUTION_HOST_V1 = "host-v1";
export const NODE_WORKER_EXECUTION_CONTAINER_V1 = "container-v1";

/**
 * The launch execution boundary is selected by the Gateway and hashed with the
 * rest of the launch. A node must never reinterpret a container launch as host work.
 */
export type NodeWorkerExecution =
  | { kind: typeof NODE_WORKER_EXECUTION_HOST_V1 }
  | { kind: typeof NODE_WORKER_EXECUTION_CONTAINER_V1 };

export type NodeWorkerLaunchInput = {
  launchId: string;
  gatewayNamespace: string;
  expectedBundleHash: string;
  placementGeneration: number;
  descriptor: WorkerLaunchPlan;
  execution: NodeWorkerExecution;
  memoryProjection?: NodeWorkerMemoryProjection;
};

export type NodeWorkerSupervisorIdentity = {
  launchId: string;
  planHash: string;
  environmentId: string;
  sessionId: string;
  ownerEpoch: number;
  placementGeneration: number;
  runId: string;
};

type NodeWorkerSupervisorActiveReceipt = NodeWorkerSupervisorIdentity & {
  state: "pending" | "running";
};

type NodeWorkerSupervisorCompletedReceipt = NodeWorkerSupervisorIdentity & {
  state: "completed";
  resultJson: string;
};

type NodeWorkerSupervisorErrorReceipt = NodeWorkerSupervisorIdentity & {
  state: "failed" | "interrupted" | "cancelled";
  errorText: string;
  /** A terminal worker identity is only durably recorded after child execution started. */
  executionStarted: boolean;
};

export type NodeWorkerSupervisorReceipt =
  | NodeWorkerSupervisorActiveReceipt
  | NodeWorkerSupervisorCompletedReceipt
  | NodeWorkerSupervisorErrorReceipt;

export type NodeWorkerConnectionFailureMessage = {
  type: typeof NODE_WORKER_CONNECTION_FAILURE_MESSAGE_TYPE;
  cause: string | null;
};

/** Private child-to-supervisor acknowledgement for the exact gate release. */
export type NodeWorkerExecutionStartedMessage = {
  type: typeof NODE_WORKER_EXECUTION_STARTED_MESSAGE_TYPE;
  launchId: string;
  planHash: string;
};

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= IDENTIFIER_MAX_CHARS &&
    value.trim() === value &&
    !value.includes("\0")
  );
}

function requireIdentifier(value: unknown, label: string): string {
  if (!isIdentifier(value)) {
    throw new Error(`INVALID_REQUEST: ${label} must be a bounded non-empty identifier`);
  }
  return value;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!isNonNegativeInteger(value)) {
    throw new Error(`INVALID_REQUEST: ${label} must be a non-negative safe integer`);
  }
  return value;
}

function isPlanHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function parseNodeWorkerExecution(value: unknown): NodeWorkerExecution | null {
  if (!isRecord(value) || !hasExactKeys(value, ["kind"])) {
    return null;
  }
  if (value.kind === NODE_WORKER_EXECUTION_HOST_V1) {
    return { kind: NODE_WORKER_EXECUTION_HOST_V1 };
  }
  if (value.kind === NODE_WORKER_EXECUTION_CONTAINER_V1) {
    return { kind: NODE_WORKER_EXECUTION_CONTAINER_V1 };
  }
  return null;
}

function requiresContainerWorkspaceRoot(descriptor: WorkerLaunchPlan): boolean {
  if (!descriptor.assignment.memoryReadEnforced) {
    return false;
  }
  return (
    descriptor.assignment.workspaceDir !== "/workspace" ||
    (descriptor.assignment.workerContainmentRoot !== undefined &&
      descriptor.assignment.workerContainmentRoot !== "/workspace")
  );
}

function requiresMemoryProjection(descriptor: WorkerLaunchPlan): boolean {
  return descriptor.assignment.memoryReadEnforced;
}

function decodeRequest(raw?: string | null): unknown {
  if (!raw) {
    throw new Error("INVALID_REQUEST: paramsJSON required");
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error("INVALID_REQUEST: paramsJSON malformed JSON");
  }
}

export function parseNodeWorkerLaunchInput(raw?: string | null): NodeWorkerLaunchInput {
  const value = decodeRequest(raw);
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      value.memoryProjection === undefined
        ? [
            "launchId",
            "gatewayNamespace",
            "expectedBundleHash",
            "placementGeneration",
            "descriptor",
            "execution",
          ]
        : [
            "launchId",
            "gatewayNamespace",
            "expectedBundleHash",
            "placementGeneration",
            "descriptor",
            "execution",
            "memoryProjection",
          ],
    )
  ) {
    throw new Error("INVALID_REQUEST: invalid node worker launch request");
  }
  const launchId = requireIdentifier(value.launchId, "launchId");
  const gatewayNamespace = requireIdentifier(value.gatewayNamespace, "gatewayNamespace");
  if (!GATEWAY_NAMESPACE_PATTERN.test(gatewayNamespace)) {
    throw new Error("INVALID_REQUEST: gatewayNamespace must be a safe bounded path component");
  }
  if (!isPlanHash(value.expectedBundleHash)) {
    throw new Error(
      "INVALID_REQUEST: expectedBundleHash must be 64 lowercase hexadecimal characters",
    );
  }
  let descriptor: WorkerLaunchPlan;
  try {
    descriptor = parseWorkerLaunchPlan(value.descriptor);
  } catch {
    throw new Error("INVALID_REQUEST: invalid worker launch descriptor");
  }
  if (descriptor.admission.handshake.bundleHash !== value.expectedBundleHash) {
    throw new Error("INVALID_REQUEST: descriptor bundle hash does not match expectedBundleHash");
  }
  const execution = parseNodeWorkerExecution(value.execution);
  if (!execution) {
    throw new Error("INVALID_REQUEST: invalid node worker execution");
  }
  if (
    descriptor.assignment.memoryReadEnforced &&
    execution.kind !== NODE_WORKER_EXECUTION_CONTAINER_V1
  ) {
    throw new Error("INVALID_REQUEST: enforced memory worker requires container-v1 execution");
  }
  if (requiresContainerWorkspaceRoot(descriptor)) {
    throw new Error(
      "INVALID_REQUEST: enforced container worker descriptor must use the /workspace root",
    );
  }
  const memoryProjection =
    value.memoryProjection === undefined
      ? undefined
      : parseNodeWorkerMemoryProjection(value.memoryProjection);
  if (value.memoryProjection !== undefined && !memoryProjection) {
    throw new Error("INVALID_REQUEST: invalid node worker memory projection");
  }
  if (requiresMemoryProjection(descriptor) !== Boolean(memoryProjection)) {
    throw new Error("INVALID_REQUEST: enforced container worker requires an issued memory projection");
  }
  if (
    memoryProjection &&
    memoryProjection.binding.launch !==
      nodeWorkerMemoryProjectionLaunchBinding({
        launchId,
        gatewayNamespace,
        expectedBundleHash: value.expectedBundleHash,
        placementGeneration: value.placementGeneration,
        descriptor,
        execution,
      })
  ) {
    throw new Error("INVALID_REQUEST: memory projection does not match its worker launch");
  }
  return {
    launchId,
    gatewayNamespace,
    expectedBundleHash: value.expectedBundleHash,
    placementGeneration: requireNonNegativeInteger(
      value.placementGeneration,
      "placementGeneration",
    ),
    descriptor,
    execution,
    ...(memoryProjection ? { memoryProjection } : {}),
  };
}

export function parseNodeWorkerLookupInput(raw?: string | null): { launchId: string } {
  const value = decodeRequest(raw);
  if (!isRecord(value) || !hasExactKeys(value, ["launchId"])) {
    throw new Error("INVALID_REQUEST: invalid node worker lookup request");
  }
  return { launchId: requireIdentifier(value.launchId, "launchId") };
}

export function parseNodeWorkerCancelInput(raw?: string | null): NodeWorkerSupervisorIdentity {
  if (!raw || Buffer.byteLength(raw, "utf8") > NODE_WORKER_SUPERVISOR_CANCEL_REQUEST_MAX_BYTES) {
    throw new Error("INVALID_REQUEST: invalid node worker cancel request");
  }
  const value = decodeRequest(raw);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "launchId",
      "planHash",
      "environmentId",
      "sessionId",
      "ownerEpoch",
      "placementGeneration",
      "runId",
    ])
  ) {
    throw new Error("INVALID_REQUEST: invalid node worker cancel request");
  }
  if (!isPlanHash(value.planHash)) {
    throw new Error("INVALID_REQUEST: planHash must be 64 lowercase hexadecimal characters");
  }
  return {
    launchId: requireIdentifier(value.launchId, "launchId"),
    planHash: value.planHash,
    environmentId: requireIdentifier(value.environmentId, "environmentId"),
    sessionId: requireIdentifier(value.sessionId, "sessionId"),
    ownerEpoch: requireNonNegativeInteger(value.ownerEpoch, "ownerEpoch"),
    placementGeneration: requireNonNegativeInteger(
      value.placementGeneration,
      "placementGeneration",
    ),
    runId: requireIdentifier(value.runId, "runId"),
  };
}

export function nodeWorkerPlanHash(
  input: Pick<
    NodeWorkerLaunchInput,
    | "descriptor"
    | "execution"
    | "expectedBundleHash"
    | "gatewayNamespace"
    | "memoryProjection"
    | "placementGeneration"
  >,
): string {
  return createHash("sha256")
    .update(
      stableStringify({
        expectedBundleHash: input.expectedBundleHash,
        descriptor: input.descriptor,
        execution: input.execution,
        gatewayNamespace: input.gatewayNamespace,
        memoryProjection: input.memoryProjection,
        placementGeneration: input.placementGeneration,
      }),
    )
    .digest("hex");
}

/**
 * A node can recompute this non-secret fence before fetching projection bytes.
 * The second opaque projection hash is verified by the Gateway against the
 * selected broker view, so swapping either launch or memory authority fails.
 */
export function nodeWorkerMemoryProjectionLaunchBinding(
  input: Pick<
    NodeWorkerLaunchInput,
    | "launchId"
    | "gatewayNamespace"
    | "expectedBundleHash"
    | "placementGeneration"
    | "descriptor"
    | "execution"
  >,
): string {
  return createHash("sha256")
    .update(
      stableStringify({
        launchId: input.launchId,
        gatewayNamespace: input.gatewayNamespace,
        expectedBundleHash: input.expectedBundleHash,
        placementGeneration: input.placementGeneration,
        execution: input.execution,
        environmentId: input.descriptor.admission.environmentId,
        sessionId: input.descriptor.admission.sessionId,
        ownerEpoch: input.descriptor.admission.ownerEpoch,
        agentId: input.descriptor.assignment.agentId,
        runId: input.descriptor.assignment.runId,
        turnId: input.descriptor.assignment.turnId,
      }),
    )
    .digest("hex");
}

const RECEIPT_IDENTITY_KEYS = [
  "launchId",
  "planHash",
  "environmentId",
  "sessionId",
  "ownerEpoch",
  "placementGeneration",
  "runId",
] as const;

function parseReceiptIdentity(value: Record<string, unknown>): NodeWorkerSupervisorIdentity | null {
  if (
    !isIdentifier(value.launchId) ||
    !isPlanHash(value.planHash) ||
    !isIdentifier(value.environmentId) ||
    !isIdentifier(value.sessionId) ||
    !isNonNegativeInteger(value.ownerEpoch) ||
    !isNonNegativeInteger(value.placementGeneration) ||
    !isIdentifier(value.runId)
  ) {
    return null;
  }
  return {
    launchId: value.launchId,
    planHash: value.planHash,
    environmentId: value.environmentId,
    sessionId: value.sessionId,
    ownerEpoch: value.ownerEpoch,
    placementGeneration: value.placementGeneration,
    runId: value.runId,
  };
}

function isBoundedResultJson(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > NODE_WORKER_RESULT_JSON_MAX_BYTES
  ) {
    return false;
  }
  try {
    return isRecord(JSON.parse(value) as unknown);
  } catch {
    return false;
  }
}

function isBoundedErrorText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= NODE_WORKER_ERROR_TEXT_MAX_BYTES &&
    !/[\r\n]/u.test(value)
  );
}

export function parseNodeWorkerConnectionFailureMessage(
  value: unknown,
): NodeWorkerConnectionFailureMessage | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["type", "cause"]) ||
    value.type !== NODE_WORKER_CONNECTION_FAILURE_MESSAGE_TYPE ||
    (value.cause !== null &&
      (typeof value.cause !== "string" ||
        value.cause.length === 0 ||
        Buffer.byteLength(value.cause, "utf8") > NODE_WORKER_CONNECTION_FAILURE_CAUSE_MAX_BYTES))
  ) {
    return null;
  }
  return {
    type: NODE_WORKER_CONNECTION_FAILURE_MESSAGE_TYPE,
    cause: value.cause,
  };
}

export function parseNodeWorkerExecutionStartedMessage(
  value: unknown,
): NodeWorkerExecutionStartedMessage | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["type", "launchId", "planHash"]) ||
    value.type !== NODE_WORKER_EXECUTION_STARTED_MESSAGE_TYPE ||
    !isIdentifier(value.launchId) ||
    !isPlanHash(value.planHash)
  ) {
    return null;
  }
  return {
    type: NODE_WORKER_EXECUTION_STARTED_MESSAGE_TYPE,
    launchId: value.launchId,
    planHash: value.planHash,
  };
}

export function parseNodeWorkerSupervisorReceipt(
  value: unknown,
): NodeWorkerSupervisorReceipt | null {
  if (!isRecord(value) || typeof value.state !== "string") {
    return null;
  }
  const identity = parseReceiptIdentity(value);
  if (!identity) {
    return null;
  }
  if (value.state === "pending" || value.state === "running") {
    return hasExactKeys(value, [...RECEIPT_IDENTITY_KEYS, "state"])
      ? { ...identity, state: value.state }
      : null;
  }
  if (value.state === "completed") {
    return hasExactKeys(value, [...RECEIPT_IDENTITY_KEYS, "state", "resultJson"]) &&
      isBoundedResultJson(value.resultJson)
      ? { ...identity, state: value.state, resultJson: value.resultJson }
      : null;
  }
  if (value.state === "failed" || value.state === "interrupted" || value.state === "cancelled") {
    return hasExactKeys(value, [...RECEIPT_IDENTITY_KEYS, "state", "errorText", "executionStarted"]) &&
      isBoundedErrorText(value.errorText) &&
      typeof value.executionStarted === "boolean"
      ? {
          ...identity,
          state: value.state,
          errorText: value.errorText,
          executionStarted: value.executionStarted,
        }
      : null;
  }
  return null;
}
