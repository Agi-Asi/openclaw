let initializedAgentIds = [];

export async function initializeMemoryBroker({ agentIds }) {
  if (agentIds.includes("fail-startup")) {
    throw new Error("test broker startup recovery failed");
  }
  initializedAgentIds = [...agentIds];
}

export function createMemoryBrokerHandler() {
  return async ({ binding, request }) => {
    if (request.method === "memory.crash") {
      // Test-only crash injection proves that the parent treats an unexpected child exit as a
      // terminal epoch. The broker must not respond from a partially stopped process.
      setImmediate(() => process.exit(1));
      return await new Promise(() => {});
    }
    if (request.method === "memory.kill") {
      // An external SIGKILL records `signalCode`, not `exitCode`. The parent must still retire
      // this process instead of waiting for an exit event that has already happened.
      setImmediate(() => process.kill(process.pid, "SIGKILL"));
      return await new Promise(() => {});
    }
    if (request.method === "memory.hang") {
      // This intentionally ignores the broker AbortSignal. Maintenance must retire the child
      // rather than leave an admission-closed but otherwise healthy process behind.
      return await new Promise(() => {});
    }
    if (request.method === "memory.startup") {
      return { agentIds: initializedAgentIds };
    }
    return request.method === "memory.environment"
      ? { parentSecret: process.env.OPENCLAW_MEMORY_BROKER_TEST_SECRET ? "present" : "absent" }
      : { agentId: binding.agentId, method: request.method };
  };
}
