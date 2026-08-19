import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isGatewayLoopbackHost } from "../../packages/gateway-client/src/websocket-transport.js";
import {
  loadOrCreateProcessDeviceIdentity,
  signDevicePayload,
  type DeviceIdentity,
} from "../infra/device-identity.js";
import { isPathInside } from "../infra/path-guards.js";
import {
  buildNodeWorkerMemoryProjectionRequestProofPayload,
  nodeWorkerMemoryProjectionTransferPath,
  parseNodeWorkerMemoryProjectionPayload,
  NODE_WORKER_MEMORY_PROJECTION_PROOF_NODE_HEADER,
  NODE_WORKER_MEMORY_PROJECTION_PROOF_SIGNATURE_HEADER,
  NODE_WORKER_MEMORY_PROJECTION_PROOF_SIGNED_AT_HEADER,
  type NodeWorkerMemoryProjection,
  type NodeWorkerMemoryProjectionPayload,
} from "../worker/node-memory-projection-protocol.js";
import type { WorkerConnectionEndpoint } from "../worker/worker-connection-endpoint.js";
import { openNodeWorkerTransferHttpRequest } from "./node-worker-transfer-http.js";

const PROJECTION_RESPONSE_MAX_BYTES = 3 * 1024 * 1024;
const PROJECTION_ROOT = "memory-projections";
const PROJECTION_ROOT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const PROJECTION_SOCKET_FORBIDDEN_ROOTS = new Set(["opt", "run", "workspace"]);

type ProjectionIdentity = Readonly<{
  gatewayNamespace: string;
  launchId: string;
  planHash: string;
}>;

function throwIfProjectionStagingAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function currentNonRootUid(): number {
  if (process.platform === "win32" || typeof process.getuid !== "function") {
    throw new Error("node worker memory projections require a non-root POSIX node host");
  }
  const uid = process.getuid();
  if (!Number.isSafeInteger(uid) || uid <= 0) {
    throw new Error("node worker memory projections require a non-root POSIX node host");
  }
  return uid;
}

function requirePrivateDirectory(directory: string, parent?: string): string {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const stats = fs.lstatSync(directory);
  const resolved = fs.realpathSync.native(directory);
  if (
    stats.isSymbolicLink() ||
    !stats.isDirectory() ||
    stats.uid !== currentNonRootUid() ||
    (stats.mode & 0o077) !== 0 ||
    (parent !== undefined && fs.realpathSync.native(path.dirname(directory)) !== parent)
  ) {
    throw new Error("node worker memory projection path is not a private owned directory");
  }
  return resolved;
}

function projectionDirectoryName(identity: ProjectionIdentity): string {
  if (!/^[a-f0-9]{64}$/u.test(identity.planHash)) {
    throw new Error("node worker memory projection plan hash is invalid");
  }
  return createHash("sha256")
    .update(`${identity.gatewayNamespace}\0${identity.launchId}\0${identity.planHash}`)
    .digest("hex");
}

function assertPayloadIntegrity(payload: NodeWorkerMemoryProjectionPayload): Array<{
  root: string;
  leaf: string;
  bytes: Buffer;
}> {
  const roots = new Set<string>();
  return payload.files.map((file) => {
    const [root, leaf] = file.virtualPath.split("/");
    const rootKey = root!.toLocaleLowerCase("en-US");
    // `memory` is the canonical authorized-view root. It stays nested below the
    // container's `/memory` mount, so it cannot shadow a container filesystem root.
    if (!PROJECTION_ROOT_PATTERN.test(root!) || PROJECTION_SOCKET_FORBIDDEN_ROOTS.has(rootKey)) {
      throw new Error("node worker memory projection root is unsafe");
    }
    roots.add(rootKey);
    const bytes = Buffer.from(file.contentBase64, "base64");
    if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
      throw new Error("node worker memory projection digest mismatch");
    }
    if (!leaf || leaf === "." || leaf === ".." || leaf.includes("/") || leaf.includes("\\")) {
      throw new Error("node worker memory projection path is unsafe");
    }
    return { root: root!, leaf, bytes };
  });
}

function assertProjectionTransferTransport(endpoint: WorkerConnectionEndpoint): void {
  const gateway = new URL(endpoint.url);
  if (gateway.protocol === "ws:" && !isGatewayLoopbackHost(gateway.hostname)) {
    throw new Error(
      "node worker memory projection requires wss:// for a non-loopback Gateway endpoint",
    );
  }
}

async function readProjectionResponse(params: {
  endpoint: WorkerConnectionEndpoint;
  projection: NodeWorkerMemoryProjection;
  deviceIdentity: DeviceIdentity;
  signal?: AbortSignal;
}): Promise<NodeWorkerMemoryProjectionPayload> {
  if (params.endpoint.kind !== "websocket") {
    throw new Error("node worker memory projection requires a Gateway WebSocket endpoint");
  }
  assertProjectionTransferTransport(params.endpoint);
  const signedAtMs = Date.now();
  const proofPayload = buildNodeWorkerMemoryProjectionRequestProofPayload({
    reference: params.projection.reference,
    binding: params.projection.binding,
    nodeId: params.deviceIdentity.deviceId,
    signedAtMs,
  });
  const response = await openNodeWorkerTransferHttpRequest({
    gatewayUrl: params.endpoint.url,
    ...(params.endpoint.tlsFingerprint ? { tlsFingerprint: params.endpoint.tlsFingerprint } : {}),
    ...(params.endpoint.cloudflareAccess
      ? { cloudflareAccess: params.endpoint.cloudflareAccess }
      : {}),
    routePath: nodeWorkerMemoryProjectionTransferPath(),
    method: "GET",
    token: params.projection.reference,
    headers: {
      [NODE_WORKER_MEMORY_PROJECTION_PROOF_NODE_HEADER]: params.deviceIdentity.deviceId,
      [NODE_WORKER_MEMORY_PROJECTION_PROOF_SIGNED_AT_HEADER]: String(signedAtMs),
      [NODE_WORKER_MEMORY_PROJECTION_PROOF_SIGNATURE_HEADER]: signDevicePayload(
        params.deviceIdentity.privateKeyPem,
        proofPayload,
      ),
    },
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (response.statusCode !== 200) {
    response.resume();
    throw new Error(`node worker memory projection transfer failed (${response.statusCode ?? 0})`);
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > PROJECTION_RESPONSE_MAX_BYTES) {
      response.destroy(new Error("node worker memory projection response exceeds its limit"));
      throw new Error("node worker memory projection response exceeds its limit");
    }
    chunks.push(value);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("node worker memory projection response is malformed");
  }
  const payload = parseNodeWorkerMemoryProjectionPayload(value);
  if (!payload) {
    throw new Error("node worker memory projection response violated its bounded contract");
  }
  return payload;
}

/**
 * Owns node-private projection staging. It is intentionally distinct from
 * workspace synchronization: projection bytes are immutable and never writable by the worker.
 */
export class NodeWorkerMemoryProjectionRuntime {
  private readonly root: string;
  private readonly deviceIdentity: DeviceIdentity;

  constructor(options: { root: string; deviceIdentity?: DeviceIdentity }) {
    const base = path.resolve(options.root, PROJECTION_ROOT);
    this.root = requirePrivateDirectory(base);
    this.deviceIdentity = options.deviceIdentity ?? loadOrCreateProcessDeviceIdentity();
  }

  private resolveDirectory(identity: ProjectionIdentity): string {
    return path.join(this.root, projectionDirectoryName(identity));
  }

  async stage(params: {
    identity: ProjectionIdentity;
    projection: NodeWorkerMemoryProjection;
    endpoint: WorkerConnectionEndpoint;
    signal?: AbortSignal;
  }): Promise<string> {
    throwIfProjectionStagingAborted(params.signal);
    if (params.projection.expiresAtMs <= Date.now()) {
      throw new Error("node worker memory projection lease expired before staging");
    }
    const destination = this.resolveDirectory(params.identity);
    throwIfProjectionStagingAborted(params.signal);
    await this.remove(params.identity);
    throwIfProjectionStagingAborted(params.signal);
    const payload = await readProjectionResponse({
      endpoint: params.endpoint,
      projection: params.projection,
      deviceIdentity: this.deviceIdentity,
      ...(params.signal ? { signal: params.signal } : {}),
    });
    throwIfProjectionStagingAborted(params.signal);
    if (params.projection.expiresAtMs <= Date.now()) {
      throw new Error("node worker memory projection lease expired during staging");
    }
    const files = assertPayloadIntegrity(payload);
    throwIfProjectionStagingAborted(params.signal);
    const temporary = await fsp.mkdtemp(path.join(this.root, ".projection-"));
    let staged = false;
    try {
      throwIfProjectionStagingAborted(params.signal);
      await fsp.chmod(temporary, 0o700);
      const preparedRoots = new Set<string>();
      for (const file of files) {
        throwIfProjectionStagingAborted(params.signal);
        const root = path.join(temporary, file.root);
        if (!preparedRoots.has(file.root)) {
          // The node must write the immutable payload before the directory can
          // become read-only to the container user.
          await fsp.mkdir(root, { mode: 0o700 });
          throwIfProjectionStagingAborted(params.signal);
          const rootStats = await fsp.lstat(root);
          if (rootStats.isSymbolicLink() || !rootStats.isDirectory() || rootStats.nlink !== 2) {
            throw new Error("node worker memory projection root is not a private directory");
          }
          preparedRoots.add(file.root);
        }
        const target = path.join(root, file.leaf);
        throwIfProjectionStagingAborted(params.signal);
        const handle = await fsp.open(target, "wx", 0o400);
        try {
          throwIfProjectionStagingAborted(params.signal);
          await handle.writeFile(file.bytes);
        } finally {
          await handle.close();
        }
        throwIfProjectionStagingAborted(params.signal);
        const stats = await fsp.lstat(target);
        if (
          stats.isSymbolicLink() ||
          !stats.isFile() ||
          stats.nlink !== 1 ||
          stats.size !== file.bytes.byteLength ||
          stats.uid !== currentNonRootUid()
        ) {
          throw new Error("node worker memory projection staged file failed integrity validation");
        }
      }
      for (const root of preparedRoots) {
        throwIfProjectionStagingAborted(params.signal);
        await fsp.chmod(path.join(temporary, root), 0o500);
      }
      throwIfProjectionStagingAborted(params.signal);
      await fsp.rename(temporary, destination);
      staged = true;
      throwIfProjectionStagingAborted(params.signal);
      const resolved = await fsp.realpath(destination);
      const stats = await fsp.lstat(resolved);
      if (
        stats.isSymbolicLink() ||
        !stats.isDirectory() ||
        path.dirname(resolved) !== this.root ||
        !isPathInside(this.root, resolved)
      ) {
        throw new Error("node worker memory projection escaped its private root");
      }
      throwIfProjectionStagingAborted(params.signal);
      return resolved;
    } catch (error) {
      await fsp.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      if (staged) {
        await this.remove(params.identity);
      }
      throw error;
    }
  }

  async remove(identity: ProjectionIdentity): Promise<void> {
    const target = this.resolveDirectory(identity);
    try {
      const [stats, parent, resolved] = await Promise.all([
        fsp.lstat(target),
        fsp.realpath(this.root),
        fsp.realpath(target),
      ]);
      if (
        stats.isSymbolicLink() ||
        !stats.isDirectory() ||
        path.dirname(resolved) !== parent ||
        !isPathInside(parent, resolved)
      ) {
        throw new Error("node worker memory projection cleanup target is not owned");
      }
      // Projection roots are made read-only before mount. Restore write access
      // only after revalidating the exact node-owned tree so cleanup cannot be
      // bypassed by its own immutable-file policy.
      await fsp.chmod(resolved, 0o700);
      for (const child of await fsp.readdir(resolved, { withFileTypes: true })) {
        if (child.isSymbolicLink() || !child.isDirectory()) {
          throw new Error("node worker memory projection cleanup tree is not owned");
        }
        const childResolved = await fsp.realpath(path.join(resolved, child.name));
        if (path.dirname(childResolved) !== resolved || !isPathInside(resolved, childResolved)) {
          throw new Error("node worker memory projection cleanup tree escaped its root");
        }
        await fsp.chmod(childResolved, 0o700);
      }
      await fsp.rm(target, { recursive: true, force: true });
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }
}
