import type { WorkerSessionsSpawnParams } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { WORKER_FULL_ACCESS_DELEGATION_CAPABILITY } from "../../worker/tool-authority.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";
import {
  resolveWorkerSessionToolSource,
  type WorkerSessionToolSource,
} from "./worker-session-tool-topology.js";

export function resolveWorkerFullAccessDelegation(params: {
  identity: WorkerConnectionIdentity;
  placements: WorkerSessionPlacementStore;
  request: WorkerSessionsSpawnParams;
  source: WorkerSessionToolSource;
}) {
  const requested = params.request.permissionMode === "full";
  const allowed = params.placements.isWorkerTurnToolAuthorized(
    params.source.turnClaim,
    WORKER_FULL_ACCESS_DELEGATION_CAPABILITY,
  );
  const assertActive = () => {
    const current = resolveWorkerSessionToolSource({
      identity: params.identity,
      placements: params.placements,
    });
    if (current.entry.permissionMode !== "full") {
      throw new Error("Worker full-access parent session authority changed");
    }
  };
  if (requested) {
    if (!allowed) {
      throw new Error("Worker full-access delegation is unavailable for this turn");
    }
    assertActive();
  }
  return {
    requested,
    allowed,
    assertActive,
    admission: {
      parentSessionId: params.source.sessionId,
      parentLifecycleRevision: params.source.entry.lifecycleRevision,
      assertActive,
    },
  };
}
