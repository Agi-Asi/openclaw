import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import type { AuthorizedMemoryVirtualFileBroker } from "../../agents/memory-authorized-read-host.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
  type DeviceIdentity,
} from "../../infra/device-identity.js";
import { NODE_WORKER_SUPERVISOR_MEMORY_PROJECTION_PROTOCOL_FEATURE } from "../../infra/node-runner-inventory.js";
import { NodeWorkerMemoryProjectionRuntime } from "../../node-host/node-worker-memory-projection.js";
import {
  buildNodeWorkerMemoryProjectionRequestProofPayload,
  nodeWorkerMemoryProjectionTransferPath,
  NODE_WORKER_MEMORY_PROJECTION_PROOF_NODE_HEADER,
  NODE_WORKER_MEMORY_PROJECTION_PROOF_SIGNATURE_HEADER,
  NODE_WORKER_MEMORY_PROJECTION_PROOF_SIGNED_AT_HEADER,
  type NodeWorkerMemoryProjection,
  type NodeWorkerMemoryProjectionBinding,
} from "../../worker/node-memory-projection-protocol.js";
import { NODE_WORKER_EXECUTION_CONTAINER_V1 } from "../../worker/node-supervisor-protocol.js";
import type { NodeWorkerSupervisorNodeProof } from "../node-registry-private.js";
import {
  createNodeWorkerProjectionTransferHttpCallback,
  handleNodeWorkerProjectionTransferHttpRequest,
} from "./node-worker-projection-transfer-http.js";
import { createNodeWorkerProjectionTransferService } from "./node-worker-projection-transfer-service.js";

function nodeProof(nodeId: string, connId = "conn-1"): NodeWorkerSupervisorNodeProof {
  return {
    nodeId,
    connId,
    pairingIdentity: "pairing-1",
    pairingGeneration: "generation-1",
    clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
    clientMode: GATEWAY_CLIENT_MODES.NODE,
    protocolFeature: NODE_WORKER_SUPERVISOR_MEMORY_PROJECTION_PROTOCOL_FEATURE,
    workerHost: {
      enabled: true,
      capacity: { total: 2, available: 2 },
      processIsolation: { kind: NODE_WORKER_EXECUTION_CONTAINER_V1, memoryProjection: 1 },
    },
    commands: [],
  };
}

function proof(params: {
  identity: DeviceIdentity;
  reference: string;
  binding: NodeWorkerMemoryProjectionBinding;
  nodeId?: string;
  signedAtMs?: number;
  signature?: string;
}) {
  const nodeId = params.nodeId ?? params.identity.deviceId;
  const signedAtMs = params.signedAtMs ?? Date.now();
  const payload = buildNodeWorkerMemoryProjectionRequestProofPayload({
    reference: params.reference,
    binding: params.binding,
    nodeId,
    signedAtMs,
  });
  return {
    nodeId,
    signedAtMs,
    signature: params.signature ?? signDevicePayload(params.identity.privateKeyPem, payload),
  };
}

async function requestProjection(params: {
  port: number;
  reference: string;
  binding: NodeWorkerMemoryProjectionBinding;
  identity: DeviceIdentity;
  nodeId?: string;
  signedAtMs?: number;
  signature?: string;
}): Promise<{ status: number; body: string }> {
  const requestProof = proof(params);
  return await new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port: params.port,
        path: nodeWorkerMemoryProjectionTransferPath(),
        method: "GET",
        headers: {
          authorization: `Bearer ${params.reference}`,
          [NODE_WORKER_MEMORY_PROJECTION_PROOF_NODE_HEADER]: requestProof.nodeId,
          [NODE_WORKER_MEMORY_PROJECTION_PROOF_SIGNED_AT_HEADER]: String(requestProof.signedAtMs),
          [NODE_WORKER_MEMORY_PROJECTION_PROOF_SIGNATURE_HEADER]: requestProof.signature,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.once("error", reject);
    request.end();
  });
}

function createTransferService(params: {
  node: NodeWorkerSupervisorNodeProof;
  identity: DeviceIdentity;
  isNodeCurrent?: (node: NodeWorkerSupervisorNodeProof) => boolean;
  generateToken?: (bytes: number) => string;
}) {
  return createNodeWorkerProjectionTransferService({
    ...((params.generateToken ? { generateToken: params.generateToken } : {}) as object),
    resolveNodePublicKey: async (candidate) =>
      candidate.nodeId === params.node.nodeId
        ? publicKeyRawBase64UrlFromPem(params.identity.publicKeyPem)
        : undefined,
    isNodeCurrent: params.isNodeCurrent ?? (() => true),
  });
}

function broker(expiresAt: string): AuthorizedMemoryVirtualFileBroker {
  const contents = new Map([["memory/MEMORY.md", "only this issued virtual view"]]);
  return {
    view: {
      version: 1,
      viewId: "view-1",
      planId: "plan-1",
      contextFingerprint: "context-1",
      revision: "revision-1",
      roots: [{ version: 1, mountHandle: "mount-1", virtualRoot: "memory", access: "read" }],
      files: [{ version: 1, mountHandle: "mount-1", virtualPath: "memory/MEMORY.md" }],
      expiresAt,
    },
    readFile: async (virtualPath) => contents.get(virtualPath),
  };
}

describe("node worker memory projection transfer", () => {
  let root: string;
  let server: http.Server | undefined;
  let identity: DeviceIdentity;

  beforeEach(async () => {
    root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "openclaw-memory-projection-wire-"),
    );
    identity = loadOrCreateDeviceIdentity({ path: path.join(root, "node-identity.sqlite") });
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  it.runIf(
    process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() > 0,
  )("stages one authorized, immutable virtual-memory snapshot and rejects replay", async () => {
    const node = nodeProof(identity.deviceId);
    const service = createTransferService({
      node,
      identity,
      generateToken: () => "A".repeat(43),
    });
    const callback = createNodeWorkerProjectionTransferHttpCallback(service);
    server = http.createServer((req, res) => {
      void handleNodeWorkerProjectionTransferHttpRequest({
        req,
        res,
        clientIp: "127.0.0.1",
        callback,
      }).catch((error: unknown) =>
        res.destroy(error instanceof Error ? error : new Error(String(error))),
      );
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not bind a TCP port");
    }
    const projection = await service.prepare({
      node,
      broker: broker(new Date(Date.now() + 60_000).toISOString()),
      environmentId: "environment-1",
      sessionId: "session-1",
      ownerEpoch: 3,
      placementGeneration: 4,
      runId: "run-1",
      launchId: "launch-1",
      launchBinding: "a".repeat(64),
      isAuthorized: () => true,
    });
    const runtime = new NodeWorkerMemoryProjectionRuntime({
      root: path.join(root, "node-host"),
      deviceIdentity: identity,
    });
    const projectionIdentity = {
      gatewayNamespace: "gateway-1",
      launchId: "launch-1",
      planHash: "a".repeat(64),
    };
    const endpoint = { kind: "websocket" as const, url: `ws://127.0.0.1:${address.port}` };

    const staged = await runtime.stage({ identity: projectionIdentity, projection, endpoint });

    expect(await fs.readFile(path.join(staged, "memory", "MEMORY.md"), "utf8")).toBe(
      "only this issued virtual view",
    );
    expect((await fs.stat(path.join(staged, "memory", "MEMORY.md"))).mode & 0o777).toBe(0o400);
    await expect(
      runtime.stage({ identity: projectionIdentity, projection, endpoint }),
    ).rejects.toThrow("projection transfer failed (404)");
    expect(await fs.readdir(path.join(root, "node-host", "memory-projections"))).toEqual([]);
  });

  it.runIf(
    process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() > 0,
  )("removes a staged projection when cancellation races its final rename", async () => {
    const node = nodeProof(identity.deviceId);
    const service = createTransferService({ node, identity });
    const callback = createNodeWorkerProjectionTransferHttpCallback(service);
    server = http.createServer((req, res) => {
      void handleNodeWorkerProjectionTransferHttpRequest({
        req,
        res,
        clientIp: "127.0.0.1",
        callback,
      }).catch((error: unknown) =>
        res.destroy(error instanceof Error ? error : new Error(String(error))),
      );
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not bind a TCP port");
    }
    const projection = await service.prepare({
      node,
      broker: broker(new Date(Date.now() + 60_000).toISOString()),
      environmentId: "environment-1",
      sessionId: "session-1",
      ownerEpoch: 3,
      placementGeneration: 4,
      runId: "run-1",
      launchId: "launch-cancelled-before-rename",
      launchBinding: "a".repeat(64),
      isAuthorized: () => true,
    });
    const runtime = new NodeWorkerMemoryProjectionRuntime({
      root: path.join(root, "node-host"),
      deviceIdentity: identity,
    });
    const projectionIdentity = {
      gatewayNamespace: "gateway-1",
      launchId: "launch-cancelled-before-rename",
      planHash: "b".repeat(64),
    };
    const controller = new AbortController();
    const rename = fs.rename;
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      controller.abort(new Error("projection revoked before process start"));
      await rename(...args);
    });
    try {
      await expect(
        runtime.stage({
          identity: projectionIdentity,
          projection,
          endpoint: { kind: "websocket", url: `ws://127.0.0.1:${address.port}` },
          signal: controller.signal,
        }),
      ).rejects.toThrow("projection revoked before process start");
    } finally {
      renameSpy.mockRestore();
    }
    expect(await fs.readdir(path.join(root, "node-host", "memory-projections"))).toEqual([]);
  });

  it("never overwrites a live capability when the token source collides", async () => {
    const node = nodeProof(identity.deviceId);
    const service = createTransferService({
      node,
      identity,
      generateToken: () => "B".repeat(43),
    });
    let authorized = true;
    const params = {
      node,
      broker: broker(new Date(Date.now() + 60_000).toISOString()),
      environmentId: "environment-1",
      sessionId: "session-1",
      ownerEpoch: 3,
      placementGeneration: 4,
      runId: "run-1",
      launchId: "launch-1",
      launchBinding: "a".repeat(64),
      isAuthorized: () => authorized,
    };

    const prepared = await service.prepare(params);
    authorized = false;
    await expect(
      service.authorize(
        prepared.reference,
        proof({ identity, reference: prepared.reference, binding: prepared.binding }),
      ),
    ).resolves.toBeUndefined();
    authorized = true;
    await expect(service.prepare({ ...params, launchId: "launch-2" })).rejects.toThrow(
      "token collision",
    );
  });

  it("rejects a wrong node proof without consuming the intended node capability", async () => {
    const node = nodeProof(identity.deviceId);
    const otherIdentity = loadOrCreateDeviceIdentity({
      path: path.join(root, "other-node.sqlite"),
    });
    const service = createTransferService({ node, identity });
    const callback = createNodeWorkerProjectionTransferHttpCallback(service);
    server = http.createServer((req, res) => {
      void handleNodeWorkerProjectionTransferHttpRequest({
        req,
        res,
        clientIp: "127.0.0.1",
        callback,
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not bind a TCP port");
    }
    const projection = await service.prepare({
      node,
      broker: broker(new Date(Date.now() + 60_000).toISOString()),
      environmentId: "environment-1",
      sessionId: "session-1",
      ownerEpoch: 3,
      placementGeneration: 4,
      runId: "run-1",
      launchId: "launch-1",
      launchBinding: "a".repeat(64),
      isAuthorized: () => true,
    });

    await expect(
      requestProjection({
        port: address.port,
        reference: projection.reference,
        binding: projection.binding,
        identity: otherIdentity,
      }),
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      requestProjection({
        port: address.port,
        reference: projection.reference,
        binding: projection.binding,
        identity,
      }),
    ).resolves.toMatchObject({ status: 200 });
  });

  it("rejects a re-signed projection binding swap without consuming the issued view", async () => {
    const node = nodeProof(identity.deviceId);
    const service = createTransferService({ node, identity });
    const callback = createNodeWorkerProjectionTransferHttpCallback(service);
    server = http.createServer((req, res) => {
      void handleNodeWorkerProjectionTransferHttpRequest({
        req,
        res,
        clientIp: "127.0.0.1",
        callback,
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not bind a TCP port");
    }
    const projection = await service.prepare({
      node,
      broker: broker(new Date(Date.now() + 60_000).toISOString()),
      environmentId: "environment-1",
      sessionId: "session-1",
      ownerEpoch: 3,
      placementGeneration: 4,
      runId: "run-1",
      launchId: "launch-1",
      launchBinding: "a".repeat(64),
      isAuthorized: () => true,
    });

    await expect(
      requestProjection({
        port: address.port,
        reference: projection.reference,
        binding: { ...projection.binding, launch: "d".repeat(64) },
        identity,
      }),
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      requestProjection({
        port: address.port,
        reference: projection.reference,
        binding: projection.binding,
        identity,
      }),
    ).resolves.toMatchObject({ status: 200 });
  });

  it("rejects stale connections and invalid proofs without consuming the current capability", async () => {
    const node = nodeProof(identity.deviceId);
    let currentNode = node;
    const service = createTransferService({
      node,
      identity,
      isNodeCurrent: (candidate) =>
        candidate.nodeId === currentNode.nodeId &&
        candidate.connId === currentNode.connId &&
        candidate.pairingGeneration === currentNode.pairingGeneration,
    });
    const callback = createNodeWorkerProjectionTransferHttpCallback(service);
    server = http.createServer((req, res) => {
      void handleNodeWorkerProjectionTransferHttpRequest({
        req,
        res,
        clientIp: "127.0.0.1",
        callback,
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not bind a TCP port");
    }
    const prepare = async (launchId: string) =>
      await service.prepare({
        node,
        broker: broker(new Date(Date.now() + 60_000).toISOString()),
        environmentId: "environment-1",
        sessionId: "session-1",
        ownerEpoch: 3,
        placementGeneration: 4,
        runId: "run-1",
        launchId,
        launchBinding: "a".repeat(64),
        isAuthorized: () => true,
      });

    const replaced = await prepare("launch-replaced");
    currentNode = nodeProof(identity.deviceId, "conn-replaced");
    await expect(
      requestProjection({
        port: address.port,
        reference: replaced.reference,
        binding: replaced.binding,
        identity,
      }),
    ).resolves.toMatchObject({ status: 404 });
    currentNode = node;
    await expect(
      requestProjection({
        port: address.port,
        reference: replaced.reference,
        binding: replaced.binding,
        identity,
      }),
    ).resolves.toMatchObject({ status: 200 });

    const invalid = await prepare("launch-invalid");
    await expect(
      requestProjection({
        port: address.port,
        reference: invalid.reference,
        binding: invalid.binding,
        identity,
        signature: "A".repeat(86),
      }),
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      requestProjection({
        port: address.port,
        reference: invalid.reference,
        binding: invalid.binding,
        identity,
      }),
    ).resolves.toMatchObject({ status: 200 });

    const expired = await prepare("launch-expired");
    await expect(
      requestProjection({
        port: address.port,
        reference: expired.reference,
        binding: expired.binding,
        identity,
        signedAtMs: Date.now() - 120_001,
      }),
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      requestProjection({
        port: address.port,
        reference: expired.reference,
        binding: expired.binding,
        identity,
      }),
    ).resolves.toMatchObject({ status: 200 });
  });

  it.runIf(
    process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() > 0,
  )(
    "refuses a plaintext non-loopback projection transport before sending a capability",
    async () => {
      const runtime = new NodeWorkerMemoryProjectionRuntime({
        root: path.join(root, "node-host"),
        deviceIdentity: identity,
      });
      const projection: NodeWorkerMemoryProjection = {
        version: 1,
        reference: "C".repeat(43),
        binding: { launch: "a".repeat(64), authorization: "b".repeat(64) },
        expiresAtMs: Date.now() + 60_000,
      };

      await expect(
        runtime.stage({
          identity: {
            gatewayNamespace: "gateway-1",
            launchId: "launch-1",
            planHash: "a".repeat(64),
          },
          projection,
          endpoint: { kind: "websocket", url: "ws://192.0.2.1:18789" },
        }),
      ).rejects.toThrow("requires wss://");
    },
  );
});
