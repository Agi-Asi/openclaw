export function createMemoryBrokerHandler() {
  return async ({ binding, request }) => {
    if (request.method === "memory.crash") {
      // Test-only crash injection proves that the parent treats an unexpected child exit as a
      // terminal epoch. The broker must not respond from a partially stopped process.
      setImmediate(() => process.exit(1));
      return await new Promise(() => {});
    }
    return request.method === "memory.environment"
      ? { parentSecret: process.env.OPENCLAW_MEMORY_BROKER_TEST_SECRET ? "present" : "absent" }
      : { agentId: binding.agentId, method: request.method };
  };
}
