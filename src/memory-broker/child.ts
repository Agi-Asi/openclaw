import { startMemoryBrokerServer } from "./server.js";
import type { MemoryBrokerChildEntry } from "./entry.js";

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
  const module = (await import(message.handlerModuleUrl)) as Partial<MemoryBrokerChildEntry>;
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
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return;
  }
  if ((message as { type?: unknown }).type === "health") {
    const requestId = (message as { requestId?: unknown }).requestId;
    const brokerEpoch = (message as { brokerEpoch?: unknown }).brokerEpoch;
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
  if ((message as { type?: unknown }).type === "maintenance") {
    const maintenance = message as Partial<BrokerMaintenanceMessage>;
    if (
      typeof maintenance.requestId !== "string" ||
      typeof maintenance.brokerEpoch !== "string" ||
      (maintenance.operation !== "quiesce" && maintenance.operation !== "resume")
    ) {
      send({ type: "maintenance", requestId: maintenance.requestId, ok: false });
      return;
    }
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
  if ((message as { type?: unknown }).type !== "start") {
    send({ type: "failed" });
    return;
  }
  void start(message as BrokerStartMessage).catch(() => {
    send({ type: "failed" });
    void close().finally(() => process.exit(1));
  });
});
