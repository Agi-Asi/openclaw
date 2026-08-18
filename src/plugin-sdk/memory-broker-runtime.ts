/**
 * Private-local broker entry contract for selected memory plugins. A broker entry executes in the
 * Gateway-owned child process and never receives agent-worker credentials or filesystem paths.
 */
export type {
  MemoryBrokerAuthorizationBinding,
  MemoryBrokerRequest,
} from "../memory-broker/protocol.js";
export type { MemoryBrokerHandler } from "../memory-broker/server.js";
