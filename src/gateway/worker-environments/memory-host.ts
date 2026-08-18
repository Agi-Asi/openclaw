import type { AuthorizedMemoryReadHost } from "../../plugins/tool-types.js";
import type { WorkerMemoryToolName } from "../../worker/tool-authority.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";

type WorkerMemoryHostBinding = Pick<
  WorkerConnectionIdentity,
  "environmentId" | "sessionId" | "runId" | "ownerEpoch"
>;

function keyFor(binding: WorkerMemoryHostBinding): string | undefined {
  if (!binding.sessionId || !binding.runId) {
    return undefined;
  }
  return `${binding.environmentId}\u0000${binding.sessionId}\u0000${binding.runId}\u0000${binding.ownerEpoch}`;
}

type WorkerMemoryHostRegistration = Readonly<{
  host: AuthorizedMemoryReadHost;
  allowedToolNames: readonly WorkerMemoryToolName[];
}>;

const hosts = new Map<string, WorkerMemoryHostRegistration>();

/**
 * Gateway registers one host only after the durable placement claim exists. The worker receives
 * neither this host nor its trusted context; its exact connection identity is the only lookup key.
 */
export function registerWorkerMemoryHost(
  binding: WorkerMemoryHostBinding,
  registration: WorkerMemoryHostRegistration,
): () => void {
  const key = keyFor(binding);
  if (!key) {
    throw new Error("worker memory host requires a session-bound worker turn");
  }
  if (hosts.has(key)) {
    throw new Error("worker memory host is already registered for this turn");
  }
  hosts.set(key, registration);
  return () => {
    // A replacement must not let an old launch tear down the newer turn's authority.
    if (hosts.get(key) === registration) {
      hosts.delete(key);
    }
  };
}

/** Returns only a host registered for this exact admitted worker connection. */
export function resolveWorkerMemoryHost(
  identity: WorkerConnectionIdentity,
): WorkerMemoryHostRegistration | undefined {
  const key = keyFor(identity);
  return key ? hosts.get(key) : undefined;
}

export function clearWorkerMemoryHostsForTest(): void {
  hosts.clear();
}
