import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { MemoryBrokerChildEntry } from "./entry.js";
import { startMemoryBrokerServer } from "./server.js";

type BrokerStartMessage = Readonly<{
  type: "start";
  socketPath: string;
  brokerId: string;
  brokerEpoch: string;
  secret: string;
  handlerModuleUrl: string;
  agentIds: readonly string[];
}>;

type BrokerMaintenanceMessage = Readonly<{
  type: "maintenance";
  requestId: string;
  brokerEpoch: string;
  operation: "quiesce" | "resume";
}>;

let closing = false;
let server: Awaited<ReturnType<typeof startMemoryBrokerServer>> | undefined;

function isBrokerStartMessage(value: unknown): value is BrokerStartMessage {
  return (
    isRecord(value) &&
    value.type === "start" &&
    typeof value.socketPath === "string" &&
    typeof value.brokerId === "string" &&
    typeof value.brokerEpoch === "string" &&
    typeof value.secret === "string" &&
    typeof value.handlerModuleUrl === "string" &&
    Array.isArray(value.agentIds) &&
    value.agentIds.every((agentId) => typeof agentId === "string" && agentId.length > 0)
  );
}

function isBrokerMaintenanceMessage(value: unknown): value is BrokerMaintenanceMessage {
  return (
    isRecord(value) &&
    value.type === "maintenance" &&
    typeof value.requestId === "string" &&
    typeof value.brokerEpoch === "string" &&
    (value.operation === "quiesce" || value.operation === "resume")
  );
}

function send(message: unknown): void {
  if (process.connected) {
    process.send?.(message);
  }
}

async function close(): Promise<void> {
  if (closing) {
    return;
  }
  closing = true;
  await server?.close();
}

async function start(message: BrokerStartMessage): Promise<void> {
  if (server || closing) {
    throw new Error("memory broker child has already started");
  }
  const module: Partial<MemoryBrokerChildEntry> = await import(message.handlerModuleUrl);
  if (typeof module.createMemoryBrokerHandler !== "function") {
    throw new Error("selected memory plugin has no broker child entry");
  }
  if (
    !Array.isArray(message.agentIds) ||
    !message.agentIds.every((agentId) => typeof agentId === "string" && agentId.length > 0)
  ) {
    throw new Error("memory broker startup agents are unavailable");
  }
  // Recovery happens before the socket exists, so a fresh/replacement child never reports
  // healthy while pending revisions can still become visible or need quarantine.
  await module.initializeMemoryBroker?.({ agentIds: Object.freeze([...message.agentIds]) });
  const handler = await module.createMemoryBrokerHandler();
  if (typeof handler !== "function") {
    throw new Error("selected memory plugin returned an invalid broker handler");
  }
  server = await startMemoryBrokerServer({
    socketPath: message.socketPath,
    brokerId: message.brokerId,
    brokerEpoch: message.brokerEpoch,
    secret: Buffer.from(message.secret, "base64url"),
    handler,
  });
  send({ type: "ready", brokerEpoch: message.brokerEpoch });
}

process.once("disconnect", () => {
  void close().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void close().finally(() => process.exit(0));
});
process.once("SIGINT", () => {
  void close().finally(() => process.exit(0));
});
process.on("message", (message: unknown) => {
  if (!isRecord(message)) {
    return;
  }
  if (message.type === "health") {
    const { requestId, brokerEpoch } = message;
    if (typeof requestId === "string" && typeof brokerEpoch === "string") {
      send({
        type: "health",
        requestId,
        brokerEpoch,
        ok: !closing && server?.brokerEpoch === brokerEpoch,
      });
    }
    return;
  }
  if (message.type === "maintenance") {
    if (!isBrokerMaintenanceMessage(message)) {
      send({
        type: "maintenance",
        ...(typeof message.requestId === "string" ? { requestId: message.requestId } : {}),
        ok: false,
      });
      return;
    }
    const maintenance = message;
    void (async () => {
      const activeServer = server;
      if (!activeServer || closing || activeServer.brokerEpoch !== maintenance.brokerEpoch) {
        send({
          type: "maintenance",
          requestId: maintenance.requestId,
          brokerEpoch: maintenance.brokerEpoch,
          ok: false,
        });
        return;
      }
      if (maintenance.operation === "quiesce") {
        await activeServer.quiesce();
      } else {
        activeServer.resume();
      }
      send({
        type: "maintenance",
        requestId: maintenance.requestId,
        brokerEpoch: maintenance.brokerEpoch,
        ok: true,
      });
    })().catch(() => {
      send({
        type: "maintenance",
        requestId: maintenance.requestId,
        brokerEpoch: maintenance.brokerEpoch,
        ok: false,
      });
    });
    return;
  }
  if (!isBrokerStartMessage(message)) {
    send({ type: "failed" });
    return;
  }
  void start(message).catch(() => {
    send({ type: "failed" });
    void close().finally(() => process.exit(1));
  });
});
