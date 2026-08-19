import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { expect, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { WORKER_PUBLIC_INGRESS_PATH } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { AuthorizedMemoryVirtualFileBroker } from "../../src/agents/memory-authorized-read-host.js";
import { execContainer } from "../../src/agents/sandbox/docker.js";
import type { NodeWorkerSupervisorNodeProof } from "../../src/gateway/node-registry-private.js";
import {
  createNodeWorkerProjectionTransferHttpCallback,
  handleNodeWorkerProjectionTransferHttpRequest,
} from "../../src/gateway/worker-environments/node-worker-projection-transfer-http.js";
import { createNodeWorkerProjectionTransferService } from "../../src/gateway/worker-environments/node-worker-projection-transfer-service.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../../src/infra/device-identity.js";
import { NODE_WORKER_SUPERVISOR_MEMORY_PROJECTION_PROTOCOL_FEATURE } from "../../src/infra/node-runner-inventory.js";
import {
  NODE_WORKER_CONTAINER_RELAY_SOCKET,
  nodeWorkerContainerName,
  removeOwnedNodeWorkerContainers,
  resolveNodeWorkerContainerEngine,
  type NodeWorkerContainerEngine,
} from "../../src/node-host/node-worker-container-runtime.js";
import { NodeWorkerMemoryProjectionRuntime } from "../../src/node-host/node-worker-memory-projection.js";
import {
  nodeWorkerMemoryProjectionLaunchBinding,
  nodeWorkerPlanHash,
} from "../../src/node-host/node-worker-supervisor-contract.js";
import { createNodeWorkerSupervisor } from "../../src/node-host/node-worker-supervisor.js";
import {
  testWorkerLaunchInput,
  writeNodeWorkerFixture,
} from "../../src/node-host/node-worker-supervisor.test-support.js";
import { NodeWorkerWorkspaceRuntime } from "../../src/node-host/node-worker-workspace.js";
import { nodeWorkerMemoryProjectionTransferPath } from "../../src/worker/node-memory-projection-protocol.js";
import { NODE_WORKER_EXECUTION_CONTAINER_V1 } from "../../src/worker/node-supervisor-protocol.js";

function nodeProof(nodeId: string): NodeWorkerSupervisorNodeProof {
  return {
    nodeId,
    connId: "container-e2e-conn",
    pairingIdentity: "container-e2e-pairing",
    pairingGeneration: "container-e2e-generation",
    clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
    clientMode: GATEWAY_CLIENT_MODES.NODE,
    protocolFeature: NODE_WORKER_SUPERVISOR_MEMORY_PROJECTION_PROTOCOL_FEATURE,
    workerHost: {
      enabled: true,
      capacity: { total: 1, available: 1 },
      processIsolation: { kind: NODE_WORKER_EXECUTION_CONTAINER_V1, memoryProjection: 1 },
    },
    commands: [],
  };
}

function workerSource(params: {
  outsideArtifactPath: string;
  issuedVirtualPath: string;
  forbiddenEnvironmentVariable: string;
}): string {
  return String.raw`
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const descriptor = JSON.parse(input);
const outsideArtifact = ${JSON.stringify(params.outsideArtifactPath)};
if (
  descriptor.connectionEndpoint?.kind !== "unix" ||
  descriptor.connectionEndpoint.socketPath !== ${JSON.stringify(NODE_WORKER_CONTAINER_RELAY_SOCKET)}
) {
  throw new Error("container worker did not receive the mounted relay endpoint");
}
const probe = (operation) => {
  try {
    operation();
    return "allowed";
  } catch (error) {
    return error && typeof error === "object" && "code" in error ? String(error.code) : "denied";
  }
};
const rawArtifactRead = (() => {
  try {
    return fs.readFileSync(outsideArtifact, "utf8");
  } catch (error) {
    return error && typeof error === "object" && "code" in error ? String(error.code) : "denied";
  }
})();
const fdTargets = fs
  .readdirSync("/proc/self/fd")
  .map((fd) => {
    try {
      return fs.readlinkSync("/proc/self/fd/" + fd);
    } catch {
      return "";
    }
  });
const mountInfo = fs.readFileSync("/proc/self/mountinfo", "utf8");
const relay = net.createConnection(descriptor.connectionEndpoint.socketPath);
let response = "";
let proved = false;
const relayEvents = [];
const writeRelayEvents = () => {
  fs.writeFileSync("/workspace/container-relay-events.json", JSON.stringify(relayEvents));
};
const fail = (message) => {
  relayEvents.push("failed:" + message);
  writeRelayEvents();
  process.stderr.write(message + "\n");
  process.exit(1);
};
relay.once("connect", () => relayEvents.push("connected"));
relay.once("error", (error) => {
  relayEvents.push("error:" + error.name + ":" + error.message);
  fail("relay connection failed: " + error.message);
});
relay.once("end", () => relayEvents.push("ended"));
relay.once("close", (hadError) => {
  relayEvents.push("closed:" + String(hadError));
  if (!proved) fail("relay closed before its WebSocket handshake");
});
relay.on("data", (chunk) => {
  relayEvents.push("data:" + String(chunk.byteLength));
  response += chunk.toString("ascii");
  if (proved || !response.includes("\r\n\r\n")) return;
  if (!response.startsWith("HTTP/1.1 101")) {
    fail("relay did not establish a WebSocket handshake: " + response.split("\r\n", 1)[0]);
    return;
  }
  proved = true;
  fs.writeFileSync(
    "/workspace/container-proof.json",
    JSON.stringify({
      issued: fs.readFileSync(${JSON.stringify(`/memory/${params.issuedVirtualPath}`)}, "utf8"),
      rawArtifactRead,
      rawArtifactRootEnumeration: probe(() => fs.readdirSync(path.dirname(outsideArtifact))),
      hostArtifactFd: fdTargets.some((target) => target.includes(outsideArtifact)),
      hostArtifactMount: mountInfo.includes(outsideArtifact),
      brokerCredentialPresent:
        process.env[${JSON.stringify(params.forbiddenEnvironmentVariable)}] !== undefined,
      memoryRoots: fs.readdirSync("/memory").sort(),
      unissuedMemoryRead: probe(() => fs.readFileSync("/memory/unissued/secret.md", "utf8")),
      issuedMemoryWrite: probe(() => fs.writeFileSync(${JSON.stringify(`/memory/${params.issuedVirtualPath}`)}, "tampered")),
      rootFilesystemWrite: probe(() => fs.writeFileSync("/etc/openclaw-isolation-probe", "tampered")),
      relaySocket: descriptor.connectionEndpoint.socketPath,
      relayEvents,
    }),
  );
  setInterval(() => {}, 1_000);
});
relay.write(
  [
    "GET / HTTP/1.1",
    "Host: localhost",
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Version: 13",
    "",
    "",
  ].join("\r\n"),
);
process.once("SIGTERM", () => {
  relay.destroy();
  process.exit(0);
});
`;
}

async function containerIds(
  engine: NodeWorkerContainerEngine,
  identity: { launchId: string; planHash: string },
) {
  const result = await execContainer(
    engine,
    ["ps", "--all", "--quiet", "--filter", `name=^/${nodeWorkerContainerName(identity)}$`],
    { allowFailure: true },
  );
  expect(result.code, result.stderr).toBe(0);
  return result.stdout
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * Exercises the generic host-to-container transfer boundary with an opaque broker.
 * Callers provide the broker so plugin-owned tests can prove their real child IPC
 * without coupling this shared harness to a bundled plugin's private implementation.
 */
export async function verifyNodeWorkerContainerProjectionIsolation(params: {
  root: string;
  broker: AuthorizedMemoryVirtualFileBroker;
  outsideArtifactPath: string;
  outsideArtifactContents: string;
  issuedVirtualPath: string;
  issuedContents: string;
  forbiddenEnvironmentVariable: string;
}): Promise<void> {
  fs.mkdirSync(params.root, { recursive: true });
  // The container projection is a short, signed copy of the already-authorized
  // broker view. Clamp only that test lease so teardown is observable without
  // changing the selected broker's independent authorization lifetime.
  const projectionBroker: AuthorizedMemoryVirtualFileBroker = {
    ...params.broker,
    view: {
      ...params.broker.view,
      expiresAt: new Date(
        Math.min(Date.parse(params.broker.view.expiresAt), Date.now() + 15_000),
      ).toISOString(),
    },
  };
  const { bundleRoot, env } = writeNodeWorkerFixture(params.root);
  const identity = loadOrCreateDeviceIdentity({
    path: path.join(params.root, "node-device-identity.sqlite"),
  });
  const node = nodeProof(identity.deviceId);
  const projectionService = createNodeWorkerProjectionTransferService({
    resolveNodePublicKey: async (candidate) =>
      candidate.nodeId === node.nodeId &&
      candidate.connId === node.connId &&
      candidate.pairingIdentity === node.pairingIdentity &&
      candidate.pairingGeneration === node.pairingGeneration
        ? publicKeyRawBase64UrlFromPem(identity.publicKeyPem)
        : undefined,
    // An exact paired connection is the authority boundary here; the just-claimed
    // node capacity is intentionally not part of the one-use projection transfer.
    isNodeCurrent: (candidate) =>
      candidate.nodeId === node.nodeId &&
      candidate.connId === node.connId &&
      candidate.pairingIdentity === node.pairingIdentity &&
      candidate.pairingGeneration === node.pairingGeneration &&
      candidate.clientId === node.clientId &&
      candidate.clientMode === node.clientMode &&
      candidate.protocolFeature === node.protocolFeature,
  });
  const projectionCallback = createNodeWorkerProjectionTransferHttpCallback(projectionService);
  const gatewaySockets = new Set<WebSocket>();
  const gatewayWebSocket = new WebSocketServer({ noServer: true });
  const projectionCapacityAtFetch: number[] = [];
  const gatewayEvents: string[] = [];
  let advertisedCapacity = 1;
  let gatewayHandshakes = 0;
  const expectedTransferPath = `${WORKER_PUBLIC_INGRESS_PATH}${nodeWorkerMemoryProjectionTransferPath()}`;
  const gateway = http.createServer((req, res) => {
    if (req.url === expectedTransferPath) {
      req.url = nodeWorkerMemoryProjectionTransferPath();
      projectionCapacityAtFetch.push(advertisedCapacity);
    }
    void handleNodeWorkerProjectionTransferHttpRequest({
      req,
      res,
      clientIp: "127.0.0.1",
      callback: projectionCallback,
    }).then(
      (handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      },
      (error: unknown) => res.destroy(error instanceof Error ? error : new Error(String(error))),
    );
  });
  gateway.on("upgrade", (request, socket, head) => {
    gatewayEvents.push(`upgrade:${request.method ?? "missing"}:${request.url ?? "missing"}`);
    if (request.url !== WORKER_PUBLIC_INGRESS_PATH) {
      gatewayEvents.push("upgrade:rejected-path");
      socket.destroy();
      return;
    }
    gatewayWebSocket.handleUpgrade(request, socket, head, (client) => {
      gatewayWebSocket.emit("connection", client, request);
    });
  });
  gateway.on("clientError", (error) => {
    gatewayEvents.push(`client-error:${error.name}:${error.message}`);
  });
  gatewayWebSocket.on("connection", (socket, request) => {
    gatewayHandshakes += 1;
    gatewayEvents.push(`websocket:connected:${request.url ?? "missing"}`);
    gatewaySockets.add(socket);
    socket.once("error", (error) => {
      gatewayEvents.push(`websocket:error:${error.name}:${error.message}`);
    });
    socket.once("close", (code, reason) => {
      gatewaySockets.delete(socket);
      gatewayEvents.push(`websocket:closed:${code}:${reason.toString("utf8")}`);
    });
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const address = gateway.address();
  if (!address || typeof address === "string") {
    throw new Error("test Gateway did not bind a TCP port");
  }

  let engine: NodeWorkerContainerEngine | undefined;
  let supervisor: ReturnType<typeof createNodeWorkerSupervisor> | undefined;
  let workspace: NodeWorkerWorkspaceRuntime | undefined;
  let containerIdentity: { launchId: string; planHash: string } | undefined;
  try {
    engine = await resolveNodeWorkerContainerEngine();
    if (!engine) {
      throw new Error("process-isolation proof requires an eligible Docker or Podman node host");
    }
    const input = testWorkerLaunchInput("/workspace", "container-relay-cancellation", "wait");
    input.execution = { kind: NODE_WORKER_EXECUTION_CONTAINER_V1 };
    input.descriptor.assignment.memoryReadEnforced = true;
    input.descriptor.assignment.workspaceDir = "/workspace";
    const projection = await projectionService.prepare({
      node,
      broker: projectionBroker,
      environmentId: input.descriptor.admission.environmentId,
      sessionId: input.descriptor.admission.sessionId,
      ownerEpoch: input.descriptor.admission.ownerEpoch,
      placementGeneration: input.placementGeneration,
      runId: input.descriptor.assignment.runId,
      launchId: input.launchId,
      launchBinding: nodeWorkerMemoryProjectionLaunchBinding(input),
      isAuthorized: () => true,
    });
    input.memoryProjection = projection;
    containerIdentity = { launchId: input.launchId, planHash: nodeWorkerPlanHash(input) };
    const bundleWorker = path.join(
      bundleRoot,
      input.gatewayNamespace,
      "bundles",
      input.expectedBundleHash,
      "worker.mjs",
    );
    fs.writeFileSync(
      bundleWorker,
      workerSource({
        outsideArtifactPath: params.outsideArtifactPath,
        issuedVirtualPath: params.issuedVirtualPath,
        forbiddenEnvironmentVariable: params.forbiddenEnvironmentVariable,
      }),
      { mode: 0o500 },
    );
    workspace = new NodeWorkerWorkspaceRuntime({ root: bundleRoot, env });
    const memoryProjection = new NodeWorkerMemoryProjectionRuntime({
      root: bundleRoot,
      deviceIdentity: identity,
    });
    const capacitySnapshots: Array<{ total: number; available: number }> = [];
    supervisor = createNodeWorkerSupervisor({
      bundleRoot,
      env,
      capacity: 1,
      onCapacityChanged: (capacity) => {
        advertisedCapacity = capacity.available;
        capacitySnapshots.push({ ...capacity });
      },
      workspace,
      memoryProjection,
    });
    const crossSessionReplay = structuredClone(input);
    crossSessionReplay.descriptor.admission.sessionId = "session-replay";
    await expect(
      supervisor.launch(crossSessionReplay, {
        kind: "websocket",
        url: `ws://127.0.0.1:${address.port}${WORKER_PUBLIC_INGRESS_PATH}`,
      }),
    ).rejects.toThrow("memory projection does not match its worker launch");
    const relayDir = workspace.resolveContainerRelayDirectory({
      gatewayNamespace: input.gatewayNamespace,
      ...containerIdentity,
    });
    const workerWorkspace = workspace.resolveContainerWorkspace({
      gatewayNamespace: input.gatewayNamespace,
      environmentId: input.descriptor.admission.environmentId,
      sessionId: input.descriptor.admission.sessionId,
      ownerEpoch: input.descriptor.admission.ownerEpoch,
    });
    const launchReceipt = await supervisor.launch(input, {
      kind: "websocket",
      url: `ws://127.0.0.1:${address.port}${WORKER_PUBLIC_INGRESS_PATH}`,
    });
    if (launchReceipt.state !== "running" || !launchReceipt.worker) {
      // The supervisor persists a scrubbed terminal diagnostic. Surface it here
      // so a remote container failure identifies its owning boundary.
      throw new Error(
        `container node worker did not start: ${launchReceipt.errorText ?? "missing terminal diagnostic"}`,
      );
    }
    const containerIdsForLaunch = await containerIds(engine, containerIdentity);
    expect(containerIdsForLaunch).toHaveLength(1);
    const labels = await execContainer(
      engine,
      [
        "inspect",
        "--format",
        '{{index .Config.Labels "openclaw.node-worker-container"}}\n{{index .Config.Labels "openclaw.node-worker-launch"}}\n{{index .Config.Labels "openclaw.node-worker-plan"}}',
        containerIdsForLaunch[0]!,
      ],
      { allowFailure: true },
    );
    expect(labels.code, labels.stderr).toBe(0);
    expect(labels.stdout.trimEnd().split(/\r?\n/u)).toEqual([
      "v1",
      containerIdentity.launchId,
      containerIdentity.planHash,
    ]);
    expect(fs.existsSync(path.join(params.root, "state-root"))).toBe(true);
    expect(fs.existsSync(path.join(relayDir, "gateway.sock"))).toBe(true);
    expect(fs.existsSync(relayDir)).toBe(true);
    try {
      await vi.waitFor(
        () => {
          expect(fs.existsSync(path.join(workerWorkspace, "container-proof.json"))).toBe(true);
        },
        { timeout: 30_000 },
      );
    } catch (error) {
      const receipt = await supervisor.status(input.launchId);
      const relayEventsPath = path.join(workerWorkspace, "container-relay-events.json");
      const relayEvents = fs.existsSync(relayEventsPath)
        ? fs.readFileSync(relayEventsPath, "utf8")
        : "missing";
      throw new Error(
        `container worker did not produce its relay proof (handshakes=${gatewayHandshakes}, gateway=${gatewayEvents.join(",") || "none"}, relay=${relayEvents}, state=${receipt?.state ?? "missing"}, detail=${receipt?.errorText ?? "none"})`,
        { cause: error },
      );
    }
    // The worker writes its proof only after the mounted relay completed its
    // WebSocket handshake, so check the connection after that async boundary.
    expect(gatewayHandshakes).toBe(1);
    const observed = JSON.parse(
      fs.readFileSync(path.join(workerWorkspace, "container-proof.json"), "utf8"),
    ) as {
      issued: string;
      rawArtifactRead: string;
      rawArtifactRootEnumeration: string;
      hostArtifactFd: boolean;
      hostArtifactMount: boolean;
      brokerCredentialPresent: boolean;
      memoryRoots: string[];
      unissuedMemoryRead: string;
      issuedMemoryWrite: string;
      rootFilesystemWrite: string;
      relaySocket: string;
      relayEvents: string[];
    };
    expect(observed).toMatchObject({
      issued: params.issuedContents,
      rawArtifactRootEnumeration: expect.not.stringMatching(/^allowed$/u),
      hostArtifactFd: false,
      hostArtifactMount: false,
      brokerCredentialPresent: false,
      memoryRoots: projectionBroker.view.roots.map((root) => root.virtualRoot).toSorted(),
      unissuedMemoryRead: expect.not.stringMatching(/^allowed$/u),
      issuedMemoryWrite: expect.not.stringMatching(/^allowed$/u),
      rootFilesystemWrite: expect.not.stringMatching(/^allowed$/u),
      relaySocket: NODE_WORKER_CONTAINER_RELAY_SOCKET,
    });
    expect(observed.rawArtifactRead).not.toBe(params.outsideArtifactContents);
    expect(projectionCapacityAtFetch).toEqual([0]);
    expect(capacitySnapshots).toContainEqual({ total: 1, available: 0 });
    await vi.waitFor(
      async () => {
        await expect(supervisor!.status(input.launchId)).resolves.toMatchObject({
          state: "cancelled",
          errorText: "node worker launch cancelled",
        });
        await expect(containerIds(engine!, containerIdentity!)).resolves.toEqual([]);
        expect(fs.existsSync(relayDir)).toBe(false);
        expect(fs.readdirSync(path.join(bundleRoot, "memory-projections"))).toEqual([]);
      },
      { timeout: 45_000 },
    );
    expect(capacitySnapshots.at(-1)).toEqual({ total: 1, available: 1 });
  } finally {
    projectionService.closeAll();
    await supervisor?.close().catch(() => undefined);
    if (engine && containerIdentity) {
      await removeOwnedNodeWorkerContainers(containerIdentity, engine).catch(() => undefined);
    }
    if (workspace && containerIdentity) {
      await workspace
        .removeContainerRelayDirectory({ gatewayNamespace: "gateway-1", ...containerIdentity })
        .catch(() => undefined);
    }
    for (const socket of gatewaySockets) {
      socket.terminate();
    }
    gatewayWebSocket.close();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
  }
}
