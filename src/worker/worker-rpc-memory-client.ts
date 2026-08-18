import { WORKER_MEMORY_PROTOCOL_FEATURE } from "../../packages/gateway-protocol/src/schema/worker-memory.js";
import type { WorkerConnection } from "./worker-connection.js";
import { fenceForOwnershipError } from "./worker-rpc-client-shared.js";

/** Worker-side client for the closed Gateway memory RPC; it owns no reusable memory authority. */
export class WorkerMemoryClient {
  constructor(private readonly connection: WorkerConnection) {}

  async search(params: { query: string; limit?: number }): Promise<unknown | undefined> {
    const hello = await this.connection.waitForReady();
    if (!hello.protocolFeatures.includes(WORKER_MEMORY_PROTOCOL_FEATURE)) {
      return undefined;
    }
    const response = await this.connection.requestMemorySearch(params);
    if (!response.ok) {
      fenceForOwnershipError(this.connection, response.error);
      return undefined;
    }
    return response.payload;
  }

  async read(params: {
    handleId: string;
    from?: number;
    lines?: number;
  }): Promise<unknown | undefined> {
    const hello = await this.connection.waitForReady();
    if (!hello.protocolFeatures.includes(WORKER_MEMORY_PROTOCOL_FEATURE)) {
      return undefined;
    }
    const response = await this.connection.requestMemoryRead(params);
    if (!response.ok) {
      fenceForOwnershipError(this.connection, response.error);
      return undefined;
    }
    return response.payload;
  }
}
