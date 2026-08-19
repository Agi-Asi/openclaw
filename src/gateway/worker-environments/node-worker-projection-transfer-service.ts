import { createHash } from "node:crypto";
import type { AuthorizedMemoryVirtualFileBroker } from "../../agents/memory-authorized-read-host.js";
import { verifyDeviceSignature } from "../../infra/device-identity.js";
import { generateSecureToken } from "../../infra/secure-random.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import {
  buildNodeWorkerMemoryProjectionRequestProofPayload,
  NODE_WORKER_MEMORY_PROJECTION_MAX_FILES,
  NODE_WORKER_MEMORY_PROJECTION_MAX_FILE_BYTES,
  NODE_WORKER_MEMORY_PROJECTION_MAX_TOTAL_BYTES,
  NODE_WORKER_MEMORY_PROJECTION_PROOF_SKEW_MS,
  NODE_WORKER_MEMORY_PROJECTION_VERSION,
  type NodeWorkerMemoryProjectionFile,
  type NodeWorkerMemoryProjectionBinding,
  type NodeWorkerMemoryProjectionPayload,
  type NodeWorkerMemoryProjection,
  type NodeWorkerMemoryProjectionRequestProof,
} from "../../worker/node-memory-projection-protocol.js";
import type { NodeWorkerSupervisorNodeProof } from "../node-registry-private.js";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
type ProjectionTransferCapability = {
  reference: string;
  node: NodeWorkerSupervisorNodeProof;
  nodeId: string;
  connId: string;
  pairingGeneration: string;
  environmentId: string;
  sessionId: string;
  ownerEpoch: number;
  placementGeneration: number;
  runId: string;
  launchId: string;
  binding: NodeWorkerMemoryProjectionBinding;
  viewId: string;
  viewRevision: string;
  viewDigest: string;
  expiresAtMs: number;
  payload: NodeWorkerMemoryProjectionPayload;
  state: "ready" | "serving";
  abortController: AbortController;
  stopWatchingSignal?: () => void;
  isAuthorized: () => boolean;
};

function projectionAuthorizationBinding(params: {
  launchBinding: string;
  broker: AuthorizedMemoryVirtualFileBroker;
}): NodeWorkerMemoryProjectionBinding {
  return Object.freeze({
    launch: params.launchBinding,
    // The selected runtime minted these opaque values from its authenticated
    // plan. Signing their digest prevents a node from substituting a launch
    // fence while retaining a different subject/actor/policy view.
    authorization: createHash("sha256")
      .update(
        JSON.stringify({
          launch: params.launchBinding,
          planId: params.broker.view.planId,
          contextFingerprint: params.broker.view.contextFingerprint,
          revision: params.broker.view.revision,
        }),
      )
      .digest("hex"),
  });
}

function mintReference(generateToken: (bytes: number) => string): string {
  const reference = generateToken(32);
  if (!TOKEN_PATTERN.test(reference)) {
    throw new Error("Worker memory projection token generator returned an invalid bearer");
  }
  registerSecretValueForRedaction(reference);
  return reference;
}

function validVirtualPath(virtualPath: string, roots: ReadonlySet<string>): boolean {
  const normalized = virtualPath.normalize("NFC");
  const parts = normalized.split("/");
  const root = parts[0];
  const leaf = parts[1];
  return (
    normalized === virtualPath &&
    parts.length === 2 &&
    Boolean(root) &&
    Boolean(leaf) &&
    roots.has(root!.toLocaleLowerCase("en-US")) &&
    leaf !== "." &&
    leaf !== ".." &&
    !leaf!.includes("\\") &&
    !leaf!.includes("\0")
  );
}

function createPayload(
  broker: AuthorizedMemoryVirtualFileBroker,
  signal?: AbortSignal,
): Promise<{
  payload: NodeWorkerMemoryProjectionPayload;
  expiresAtMs: number;
  viewDigest: string;
}> {
  return (async () => {
    signal?.throwIfAborted();
    const view = broker.view;
    const expiresAtMs = Date.parse(view.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      throw new Error("Authorized memory virtual view is expired");
    }
    if (view.files.length === 0 || view.files.length > NODE_WORKER_MEMORY_PROJECTION_MAX_FILES) {
      throw new Error("Authorized memory virtual view exceeds projection file limits");
    }
    const roots = new Set<string>();
    for (const root of view.roots) {
      const name = root.virtualRoot.normalize("NFC");
      const key = name.toLocaleLowerCase("en-US");
      // `/memory` is the container mount target, not this payload's root. The
      // canonical selected-memory view uses `memory/...`, nested under that mount.
      if (
        name !== root.virtualRoot ||
        !name ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(name) ||
        roots.has(key) ||
        ["opt", "run", "workspace"].includes(key)
      ) {
        throw new Error("Authorized memory virtual view has an unsafe projection root");
      }
      roots.add(key);
    }
    const paths = new Set<string>();
    let totalBytes = 0;
    const files: NodeWorkerMemoryProjectionFile[] = [];
    for (const file of [...view.files].toSorted((left, right) =>
      left.virtualPath.localeCompare(right.virtualPath),
    )) {
      signal?.throwIfAborted();
      if (!validVirtualPath(file.virtualPath, roots)) {
        throw new Error("Authorized memory virtual view has an unsafe projection path");
      }
      const key = file.virtualPath.toLocaleLowerCase("en-US");
      if (paths.has(key)) {
        throw new Error("Authorized memory virtual view has colliding projection paths");
      }
      paths.add(key);
      const text = await broker.readFile(file.virtualPath, signal);
      signal?.throwIfAborted();
      if (text === undefined) {
        throw new Error("Authorized memory virtual view could not materialize an issued file");
      }
      const bytes = Buffer.from(text, "utf8");
      if (bytes.byteLength > NODE_WORKER_MEMORY_PROJECTION_MAX_FILE_BYTES) {
        throw new Error("Authorized memory virtual view exceeds projection file limits");
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > NODE_WORKER_MEMORY_PROJECTION_MAX_TOTAL_BYTES) {
        throw new Error("Authorized memory virtual view exceeds projection total limits");
      }
      files.push(
        Object.freeze({
          virtualPath: file.virtualPath,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          contentBase64: bytes.toString("base64"),
        }),
      );
    }
    const payload = Object.freeze({
      version: NODE_WORKER_MEMORY_PROJECTION_VERSION,
      files: Object.freeze(files),
    });
    return {
      payload,
      expiresAtMs,
      viewDigest: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
    };
  })();
}

export function createNodeWorkerProjectionTransferService(
  options: {
    now?: () => number;
    generateToken?: (bytes: number) => string;
    resolveNodePublicKey?: (node: NodeWorkerSupervisorNodeProof) => Promise<string | undefined>;
    isNodeCurrent?: (node: NodeWorkerSupervisorNodeProof) => boolean;
  } = {},
) {
  const now = options.now ?? Date.now;
  const generateToken = options.generateToken ?? generateSecureToken;
  const resolveNodePublicKey = options.resolveNodePublicKey ?? (async () => undefined);
  const isNodeCurrent = options.isNodeCurrent ?? (() => false);
  const capabilities = new Map<string, ProjectionTransferCapability>();

  const isCurrent = (capability: ProjectionTransferCapability): boolean =>
    capabilities.get(capability.reference) === capability &&
    capability.state === "serving" &&
    capability.expiresAtMs > now() &&
    !capability.abortController.signal.aborted &&
    capability.isAuthorized() &&
    isNodeCurrent(capability.node);

  const isReady = (
    capability: ProjectionTransferCapability | undefined,
  ): capability is ProjectionTransferCapability =>
    Boolean(
      capability &&
      capabilities.get(capability.reference) === capability &&
      capability.state === "ready" &&
      capability.expiresAtMs > now() &&
      !capability.abortController.signal.aborted &&
      capability.isAuthorized() &&
      isNodeCurrent(capability.node),
    );

  const revokeCapability = (capability: ProjectionTransferCapability): void => {
    if (capabilities.get(capability.reference) === capability) {
      capabilities.delete(capability.reference);
    }
    capability.stopWatchingSignal?.();
    if (!capability.abortController.signal.aborted) {
      capability.abortController.abort(new Error("Worker memory projection capability closed"));
    }
  };

  return {
    async prepare(params: {
      node: NodeWorkerSupervisorNodeProof;
      broker: AuthorizedMemoryVirtualFileBroker;
      environmentId: string;
      sessionId: string;
      ownerEpoch: number;
      placementGeneration: number;
      runId: string;
      launchId: string;
      launchBinding: string;
      isAuthorized: () => boolean;
      signal?: AbortSignal;
    }): Promise<NodeWorkerMemoryProjection> {
      if (!params.isAuthorized() || !isNodeCurrent(params.node)) {
        throw new Error("Worker memory projection authority is unavailable");
      }
      if (!/^[a-f0-9]{64}$/u.test(params.launchBinding)) {
        throw new Error("Worker memory projection launch binding is invalid");
      }
      params.signal?.throwIfAborted();
      const snapshot = await createPayload(params.broker, params.signal);
      if (!params.isAuthorized() || snapshot.expiresAtMs <= now()) {
        throw new Error("Worker memory projection authority is unavailable");
      }
      params.signal?.throwIfAborted();
      const reference = mintReference(generateToken);
      if (capabilities.has(reference)) {
        // A collision must never replace a live single-use capability, even in a
        // test or an incorrectly substituted entropy source.
        throw new Error("Worker memory projection token collision");
      }
      const capability: ProjectionTransferCapability = {
        reference,
        node: params.node,
        nodeId: params.node.nodeId,
        connId: params.node.connId,
        pairingGeneration: params.node.pairingGeneration,
        environmentId: params.environmentId,
        sessionId: params.sessionId,
        ownerEpoch: params.ownerEpoch,
        placementGeneration: params.placementGeneration,
        runId: params.runId,
        launchId: params.launchId,
        binding: projectionAuthorizationBinding({
          launchBinding: params.launchBinding,
          broker: params.broker,
        }),
        viewId: params.broker.view.viewId,
        viewRevision: params.broker.view.revision,
        viewDigest: snapshot.viewDigest,
        expiresAtMs: snapshot.expiresAtMs,
        payload: snapshot.payload,
        state: "ready",
        abortController: new AbortController(),
        isAuthorized: params.isAuthorized,
      };
      if (params.signal) {
        const abort = () => revokeCapability(capability);
        params.signal.addEventListener("abort", abort, { once: true });
        capability.stopWatchingSignal = () => params.signal?.removeEventListener("abort", abort);
        if (params.signal.aborted) {
          abort();
        }
      }
      if (capability.abortController.signal.aborted) {
        throw new Error("Worker memory projection authority is unavailable");
      }
      capabilities.set(reference, capability);
      return Object.freeze({
        version: NODE_WORKER_MEMORY_PROJECTION_VERSION,
        reference,
        binding: capability.binding,
        expiresAtMs: capability.expiresAtMs,
      });
    },

    async authorize(
      reference: string,
      proof: NodeWorkerMemoryProjectionRequestProof,
    ): Promise<ProjectionTransferCapability | undefined> {
      const capability = capabilities.get(reference);
      if (
        !isReady(capability) ||
        proof.nodeId !== capability.nodeId ||
        Math.abs(now() - proof.signedAtMs) > NODE_WORKER_MEMORY_PROJECTION_PROOF_SKEW_MS
      ) {
        return undefined;
      }
      const publicKey = await resolveNodePublicKey(capability.node).catch(() => undefined);
      if (!publicKey || !isReady(capability)) {
        return undefined;
      }
      const payload = buildNodeWorkerMemoryProjectionRequestProofPayload({
        reference,
        binding: capability.binding,
        nodeId: capability.nodeId,
        signedAtMs: proof.signedAtMs,
      });
      if (!verifyDeviceSignature(publicKey, payload, proof.signature) || !isReady(capability)) {
        return undefined;
      }
      // This is the final synchronous check before ready -> serving. A stale
      // connection or invalid signature leaves the one-use capability intact.
      capability.state = "serving";
      return capability;
    },

    isAuthorizationCurrent: isCurrent,

    authorizationSignal(capability: ProjectionTransferCapability): AbortSignal {
      return capability.abortController.signal;
    },

    payload(
      capability: ProjectionTransferCapability,
    ): NodeWorkerMemoryProjectionPayload | undefined {
      return isCurrent(capability) ? capability.payload : undefined;
    },

    revoke(capabilityOrReference: ProjectionTransferCapability | string): void {
      const capability =
        typeof capabilityOrReference === "string"
          ? capabilities.get(capabilityOrReference)
          : capabilityOrReference;
      if (capability) {
        revokeCapability(capability);
      }
    },

    closeAll(): void {
      for (const capability of capabilities.values()) {
        revokeCapability(capability);
      }
    },
  };
}

export type NodeWorkerProjectionTransferService = ReturnType<
  typeof createNodeWorkerProjectionTransferService
>;
