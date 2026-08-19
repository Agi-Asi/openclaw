import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { NODE_WORKER_SUPERVISOR_MEMORY_PROJECTION_PROTOCOL_FEATURE } from "../infra/node-runner-inventory.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { NODE_WORKER_EXECUTION_CONTAINER_V1 } from "../worker/node-supervisor-protocol.js";
import { createDesktopSessionRegistry } from "./desktop/session-registry.js";
import type {
  NodeWorkerSupervisorNodeProof,
  NodeWorkerSupervisorTransport,
} from "./node-registry-private.js";
import {
  createGatewayWorkerEnvironmentRuntime,
  loadGatewayWorkerEnvironmentStartupState,
} from "./server-worker-environment-startup.js";
import { hashWorkerCredential } from "./worker-environments/credential.js";
import {
  DEVICE_WORKER_PROVIDER_ID,
  reconcileDeviceWorker,
} from "./worker-environments/device-provider.js";

const projectionTransferOptions = vi.hoisted(() => ({
  isNodeCurrent: undefined as ((node: NodeWorkerSupervisorNodeProof) => boolean) | undefined,
}));

vi.mock("./worker-environments/node-worker-projection-transfer-service.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("./worker-environments/node-worker-projection-transfer-service.js")
  >();
  return {
    ...actual,
    createNodeWorkerProjectionTransferService: (
      options: Parameters<typeof actual.createNodeWorkerProjectionTransferService>[0],
    ) => {
      projectionTransferOptions.isNodeCurrent = options.isNodeCurrent;
      return actual.createNodeWorkerProjectionTransferService(options);
    },
  };
});

const DEVICE_ID = "revoked-device";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("gateway worker environment startup", () => {
  it("keeps an issued projection bound to its capacity-one node after its slot is claimed", async () => {
    const stateDir = tempDirs.make("openclaw-worker-projection-capacity-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const startup = await loadGatewayWorkerEnvironmentStartupState();
      const runtime = await createGatewayWorkerEnvironmentRuntime({
        getPluginRegistry: () => ({ workerProviders: new Map() }),
        desktopSessionRegistry: createDesktopSessionRegistry({ lingerMs: 1 }),
        startup,
        log: { child: () => ({ warn: () => {} }) },
      });
      const service = runtime.workerEnvironmentService;
      if (!service || !runtime.bindDeviceNodeControl || !projectionTransferOptions.isNodeCurrent) {
        throw new Error("worker projection runtime was not created");
      }
      const node: NodeWorkerSupervisorNodeProof = {
        nodeId: "node-1",
        connId: "conn-1",
        pairingIdentity: "pairing-1",
        pairingGeneration: "generation-1",
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
      let available = 1;
      let connId = node.connId;
      let pairingGeneration = node.pairingGeneration;
      const transport = {
        listCurrentNodes: async () => [node],
        isCurrent: vi.fn(
          (candidate: NodeWorkerSupervisorNodeProof, requireLaunchEligibility = false) =>
            candidate.nodeId === node.nodeId &&
            candidate.connId === connId &&
            candidate.pairingGeneration === pairingGeneration &&
            (!requireLaunchEligibility || available > 0),
        ),
        invoke: async () => ({ ok: false }),
      } satisfies NodeWorkerSupervisorTransport;
      runtime.bindDeviceNodeControl(transport);
      const isNodeCurrent = projectionTransferOptions.isNodeCurrent;

      try {
        expect(isNodeCurrent(node)).toBe(true);
        available = 0;
        expect(isNodeCurrent(node)).toBe(true);
        expect(transport.isCurrent).toHaveBeenLastCalledWith(node, false);

        connId = "conn-replaced";
        expect(isNodeCurrent(node)).toBe(false);
        connId = node.connId;
        pairingGeneration = "generation-replaced";
        expect(isNodeCurrent(node)).toBe(false);
      } finally {
        await service.stop();
      }
    });
  });

  it("cleans transfer scratch before serving and removes it on shutdown", async () => {
    const stateDir = tempDirs.make("openclaw-worker-transfer-startup-");
    const transferRoot = path.join(stateDir, "tmp", "node-workspace-transfer");
    const staleRoot = path.join(transferRoot, "context-stale");
    await fs.mkdir(staleRoot, { recursive: true });
    await fs.writeFile(path.join(staleRoot, "base.pack"), "stale");

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const startup = await loadGatewayWorkerEnvironmentStartupState();
      const runtime = await createGatewayWorkerEnvironmentRuntime({
        getPluginRegistry: () => ({ workerProviders: new Map() }),
        desktopSessionRegistry: createDesktopSessionRegistry({ lingerMs: 1 }),
        startup,
        log: { child: () => ({ warn: () => {} }) },
      });
      const service = runtime.workerEnvironmentService;
      if (!service) {
        throw new Error("worker environment service was not created");
      }
      try {
        await expect(fs.readdir(transferRoot)).resolves.toEqual([]);
      } finally {
        await service.stop();
      }
      await expect(fs.stat(transferRoot)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("binds device revocation to the persisted profile settings", async () => {
    const stateDir = tempDirs.make("openclaw-worker-startup-");
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const startup = await loadGatewayWorkerEnvironmentStartupState();
        startup.store.createIntent({
          environmentId: "device-environment",
          providerId: DEVICE_WORKER_PROVIDER_ID,
          profileId: `device:${DEVICE_ID}`,
          profileSnapshot: { install: "bundle", settings: { device: DEVICE_ID } },
          provisionOperationId: "provision:device-environment",
        });
        startup.store.transition({
          environmentId: "device-environment",
          from: "requested",
          to: "provisioning",
        });
        startup.store.transition({
          environmentId: "device-environment",
          from: "provisioning",
          to: "ready",
          patch: {
            leaseId: "device-lease",
            nodeDeviceId: DEVICE_ID,
            sshEndpoint: null,
            sharedHost: true,
            bootstrapReceipt: {
              bundleHash: "a".repeat(64),
              openclawVersion: "2026.8.14",
              protocolFeatures: ["worker-heartbeat-v1"],
              installKind: "bundle",
            },
            credential: {
              credentialHash: hashWorkerCredential("device-credential"),
              sessionId: null,
              rpcSetVersion: 1,
              expiresAtMs: Date.now() + 60_000,
            },
          },
        });

        const runtime = await createGatewayWorkerEnvironmentRuntime({
          getPluginRegistry: () => ({ workerProviders: new Map() }),
          desktopSessionRegistry: createDesktopSessionRegistry({ lingerMs: 1 }),
          startup,
          log: { child: () => ({ warn: () => {} }) },
        });
        const service = runtime.workerEnvironmentService;
        if (!service) {
          throw new Error("worker environment service was not created");
        }
        try {
          await expect(reconcileDeviceWorker(service, DEVICE_ID)).resolves.toEqual([
            "device-environment",
          ]);
          expect(startup.store.getCredential("device-environment")).toBeUndefined();
          expect(startup.store.get("device-environment")?.state).toBe("orphaned");
        } finally {
          await service.stop();
        }
      });
    } finally {
      closeOpenClawStateDatabaseForTest();
    }
  });
});
