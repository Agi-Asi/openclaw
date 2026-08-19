/** Private, single-use Gateway-to-node transfer for an authorized virtual-memory snapshot. */
import { isRecord } from "@openclaw/normalization-core/record-coerce";

export const NODE_WORKER_MEMORY_PROJECTION_TRANSFER_PATH =
  "/__openclaw__/worker-memory-projection/v1";
export const NODE_WORKER_MEMORY_PROJECTION_VERSION = 1;
export const NODE_WORKER_MEMORY_PROJECTION_MAX_FILES = 64;
export const NODE_WORKER_MEMORY_PROJECTION_MAX_FILE_BYTES = 256 * 1024;
export const NODE_WORKER_MEMORY_PROJECTION_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
export const NODE_WORKER_MEMORY_PROJECTION_PROOF_SKEW_MS = 2 * 60 * 1_000;
export const NODE_WORKER_MEMORY_PROJECTION_PROOF_NODE_HEADER = "x-openclaw-worker-projection-node";
export const NODE_WORKER_MEMORY_PROJECTION_PROOF_SIGNED_AT_HEADER =
  "x-openclaw-worker-projection-signed-at";
export const NODE_WORKER_MEMORY_PROJECTION_PROOF_SIGNATURE_HEADER =
  "x-openclaw-worker-projection-signature";

const REFERENCE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const PROJECTION_BINDING_PATTERN = /^[a-f0-9]{64}$/u;
const RESERVED_VIRTUAL_ROOTS = new Set(["opt", "run", "workspace"]);
const PROOF_NODE_ID_PATTERN = /^[^\0\r\n]{1,256}$/u;
const ED25519_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/u;

/**
 * This is deliberately the only projection datum serializable into a node launch.
 * Its opaque, single-use bearer and non-secret expiry never name a store, artifact,
 * view, or host path.
 */
export type NodeWorkerMemoryProjection = Readonly<{
  version: typeof NODE_WORKER_MEMORY_PROJECTION_VERSION;
  reference: string;
  /**
   * Gateway-issued opaque hashes. `launch` fences the descriptor that the node
   * may stage for; `authorization` also commits to the selected broker view.
   */
  binding: NodeWorkerMemoryProjectionBinding;
  /**
   * Non-secret Gateway-issued lease for the locally staged immutable view.
   * The node uses it to withdraw the container after a lost Gateway connection.
   */
  expiresAtMs: number;
}>;

export type NodeWorkerMemoryProjectionBinding = Readonly<{
  launch: string;
  authorization: string;
}>;

/**
 * Node-host proof for a one-use projection retrieval. The Gateway binds this
 * signature to the issued capability's exact node connection before consuming it.
 */
export type NodeWorkerMemoryProjectionRequestProof = Readonly<{
  nodeId: string;
  signedAtMs: number;
  signature: string;
}>;

export type NodeWorkerMemoryProjectionFile = Readonly<{
  virtualPath: string;
  sha256: string;
  contentBase64: string;
}>;

export type NodeWorkerMemoryProjectionPayload = Readonly<{
  version: typeof NODE_WORKER_MEMORY_PROJECTION_VERSION;
  files: readonly NodeWorkerMemoryProjectionFile[];
}>;

export function parseNodeWorkerMemoryProjection(value: unknown): NodeWorkerMemoryProjection | null {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 4 ||
    !Object.hasOwn(value, "version") ||
    !Object.hasOwn(value, "reference") ||
    !Object.hasOwn(value, "binding") ||
    !Object.hasOwn(value, "expiresAtMs") ||
    value.version !== NODE_WORKER_MEMORY_PROJECTION_VERSION ||
    typeof value.reference !== "string" ||
    !REFERENCE_PATTERN.test(value.reference) ||
    !isRecord(value.binding) ||
    Object.keys(value.binding).length !== 2 ||
    typeof value.binding.launch !== "string" ||
    !PROJECTION_BINDING_PATTERN.test(value.binding.launch) ||
    typeof value.binding.authorization !== "string" ||
    !PROJECTION_BINDING_PATTERN.test(value.binding.authorization) ||
    typeof value.expiresAtMs !== "number" ||
    !Number.isSafeInteger(value.expiresAtMs) ||
    value.expiresAtMs < 0
  ) {
    return null;
  }
  return Object.freeze({
    version: NODE_WORKER_MEMORY_PROJECTION_VERSION,
    reference: value.reference,
    binding: Object.freeze({
      launch: value.binding.launch,
      authorization: value.binding.authorization,
    }),
    expiresAtMs: value.expiresAtMs,
  });
}

export function parseNodeWorkerMemoryProjectionRequestProof(
  value: unknown,
): NodeWorkerMemoryProjectionRequestProof | null {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 3 ||
    !Object.hasOwn(value, "nodeId") ||
    !Object.hasOwn(value, "signedAtMs") ||
    !Object.hasOwn(value, "signature") ||
    typeof value.nodeId !== "string" ||
    !PROOF_NODE_ID_PATTERN.test(value.nodeId) ||
    typeof value.signedAtMs !== "number" ||
    !Number.isSafeInteger(value.signedAtMs) ||
    value.signedAtMs < 0 ||
    typeof value.signature !== "string" ||
    !ED25519_SIGNATURE_PATTERN.test(value.signature)
  ) {
    return null;
  }
  return Object.freeze({
    nodeId: value.nodeId,
    signedAtMs: value.signedAtMs,
    signature: value.signature,
  });
}

/** Canonical domain-separated payload signed by the node-host device identity. */
export function buildNodeWorkerMemoryProjectionRequestProofPayload(params: {
  reference: string;
  binding: NodeWorkerMemoryProjectionBinding;
  nodeId: string;
  signedAtMs: number;
}): string {
  if (
    !REFERENCE_PATTERN.test(params.reference) ||
    !PROJECTION_BINDING_PATTERN.test(params.binding.launch) ||
    !PROJECTION_BINDING_PATTERN.test(params.binding.authorization) ||
    !PROOF_NODE_ID_PATTERN.test(params.nodeId) ||
    !Number.isSafeInteger(params.signedAtMs) ||
    params.signedAtMs < 0
  ) {
    throw new Error("invalid node worker memory projection request proof");
  }
  return [
    "openclaw.node-worker-memory-projection.request.v1",
    "GET",
    nodeWorkerMemoryProjectionTransferPath(),
    params.reference,
    params.binding.launch,
    params.binding.authorization,
    params.nodeId,
    String(params.signedAtMs),
  ].join("\n");
}

function isSafeVirtualPath(value: unknown): value is string {
  if (typeof value !== "string" || value !== value.normalize("NFC")) {
    return false;
  }
  const [root, leaf, ...rest] = value.split("/");
  // `memory/...` is the canonical selected-memory view, nested below the
  // container's fixed `/memory` mount rather than a host filesystem path.
  return (
    Boolean(root) &&
    Boolean(leaf) &&
    rest.length === 0 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(root!) &&
    !RESERVED_VIRTUAL_ROOTS.has(root!.toLocaleLowerCase("en-US")) &&
    leaf !== "." &&
    leaf !== ".." &&
    !leaf!.includes("\\") &&
    !leaf!.includes("\0")
  );
}

/** Parses the bounded immutable response before a node ever writes a projection byte. */
export function parseNodeWorkerMemoryProjectionPayload(
  value: unknown,
): NodeWorkerMemoryProjectionPayload | null {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, "version") ||
    !Object.hasOwn(value, "files") ||
    value.version !== NODE_WORKER_MEMORY_PROJECTION_VERSION ||
    !Array.isArray(value.files)
  ) {
    return null;
  }
  const files = value.files;
  if (files.length === 0 || files.length > NODE_WORKER_MEMORY_PROJECTION_MAX_FILES) {
    return null;
  }
  let totalBytes = 0;
  const paths = new Set<string>();
  const parsed: NodeWorkerMemoryProjectionFile[] = [];
  for (const file of files) {
    if (
      !isRecord(file) ||
      Object.keys(file).length !== 3 ||
      !Object.hasOwn(file, "virtualPath") ||
      !Object.hasOwn(file, "sha256") ||
      !Object.hasOwn(file, "contentBase64") ||
      !isSafeVirtualPath(file.virtualPath) ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(file.sha256) ||
      typeof file.contentBase64 !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(file.contentBase64)
    ) {
      return null;
    }
    const contentBase64 = file.contentBase64;
    const bytes = Buffer.byteLength(contentBase64, "base64");
    if (bytes > NODE_WORKER_MEMORY_PROJECTION_MAX_FILE_BYTES) {
      return null;
    }
    totalBytes += bytes;
    if (totalBytes > NODE_WORKER_MEMORY_PROJECTION_MAX_TOTAL_BYTES) {
      return null;
    }
    const virtualPath = file.virtualPath;
    const key = virtualPath.toLocaleLowerCase("en-US");
    if (paths.has(key)) {
      return null;
    }
    paths.add(key);
    parsed.push(
      Object.freeze({
        virtualPath,
        sha256: file.sha256,
        contentBase64,
      }),
    );
  }
  return Object.freeze({
    version: NODE_WORKER_MEMORY_PROJECTION_VERSION,
    files: Object.freeze(parsed),
  });
}

/** The bearer is sent in Authorization, not placed in a URL or request body. */
export function nodeWorkerMemoryProjectionTransferPath(): string {
  return `${NODE_WORKER_MEMORY_PROJECTION_TRANSFER_PATH}/projection`;
}
