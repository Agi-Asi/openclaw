import type { MemoryBrokerHandler } from "./server.js";

/**
 * Gateway passes this small, path-free startup snapshot over inherited parent-child IPC before
 * the broker opens its agent-visible socket. A plugin must finish recovery or throw; ready means
 * the selected runtime has completed its own durable-startup fence.
 */
export type MemoryBrokerStartupContext = Readonly<{
  agentIds: readonly string[];
}>;

/** Public selected-memory child entry contract. */
export type MemoryBrokerChildEntry = Readonly<{
  createMemoryBrokerHandler: () => MemoryBrokerHandler | Promise<MemoryBrokerHandler>;
  initializeMemoryBroker?: (
    context: MemoryBrokerStartupContext,
  ) => void | Promise<void>;
}>;
