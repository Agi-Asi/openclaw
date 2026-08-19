import fs from "node:fs/promises";
import http from "node:http";
import type { Socket } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { WORKER_PROTOCOL_MAX_PAYLOAD_BYTES } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { startNodeWorkerGatewayRelay } from "./node-worker-gateway-relay.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(async (cleanup) => await cleanup()));
});

async function relayHarness(params: {
  onUpstreamConnection?: (socket: WebSocket) => void;
  onUpstreamUpgrade?: (socket: Socket) => void;
} = {}) {
  // Keep the lexical path short: the production relay intentionally does the
  // same because macOS rejects canonical state paths as Unix socket names.
  const root = await fs.mkdtemp("/tmp/node-worker-relay-");
  const upstreamServer = http.createServer();
  const rawUpstreamSockets = new Set<Socket>();
  const upstreamClients: WebSocket[] = [];
  if (params.onUpstreamUpgrade) {
    upstreamServer.on("upgrade", (_request, socket) => {
      rawUpstreamSockets.add(socket);
      socket.once("close", () => rawUpstreamSockets.delete(socket));
      params.onUpstreamUpgrade?.(socket);
    });
  } else {
    const upstreamWebSocket = new WebSocketServer({ server: upstreamServer });
    upstreamWebSocket.on("connection", (socket) => {
      upstreamClients.push(socket);
      if (params.onUpstreamConnection) {
        params.onUpstreamConnection(socket);
        return;
      }
      socket.on("message", (message, binary) => socket.send(message, { binary }));
    });
  }
  await new Promise<void>((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));
  const address = upstreamServer.address();
  if (!address || typeof address === "string") {
    throw new Error("expected upstream server address");
  }
  const relay = await startNodeWorkerGatewayRelay({
    directory: root,
    upstream: { kind: "websocket", url: `ws://127.0.0.1:${address.port}/__openclaw__/worker` },
  });
  cleanups.push(async () => {
    await relay.close();
    for (const socket of rawUpstreamSockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { relay, upstreamClients };
}

async function connect(socketPath: string): Promise<WebSocket> {
  const socket = new WebSocket(`ws+unix://${socketPath}:/`);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

function waitForClose(socket: WebSocket): Promise<number> {
  return new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
}

async function expectConnectFailure(socketPath: string): Promise<void> {
  const probe = new WebSocket(`ws+unix://${socketPath}:/`);
  await new Promise<void>((resolve, reject) => {
    probe.once("open", () => reject(new Error("closed relay unexpectedly accepted a client")));
    probe.once("error", () => resolve());
  });
}

describe("node worker gateway relay", () => {
  it("forwards one bounded local client and rejects a second client", async () => {
    const { relay } = await relayHarness();
    const first = await connect(relay.socketPath);
    cleanups.push(async () => first.terminate());

    const echoed = new Promise<Buffer>((resolve) => {
      first.once("message", (message) => resolve(Buffer.from(message)));
    });
    first.send(Buffer.from("worker-frame"));
    await expect(echoed).resolves.toEqual(Buffer.from("worker-frame"));

    const second = new WebSocket(`ws+unix://${relay.socketPath}:/`);
    cleanups.push(async () => second.terminate());
    await expect(
      new Promise<number>((resolve, reject) => {
        second.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
        second.once("open", () => reject(new Error("second relay client unexpectedly connected")));
        second.once("error", () => undefined);
      }),
    ).resolves.toBe(409);
  });

  it("closes an oversized worker frame before forwarding it upstream", async () => {
    const { relay } = await relayHarness();
    const client = await connect(relay.socketPath);
    cleanups.push(async () => client.terminate());

    const closed = new Promise<number>((resolve) => client.once("close", (code) => resolve(code)));
    client.send(Buffer.alloc(WORKER_PROTOCOL_MAX_PAYLOAD_BYTES + 1));

    await expect(closed).resolves.toBe(1009);
  });

  it("closes a worker that exceeds the bounded pre-upstream queue", async () => {
    const { relay } = await relayHarness({
      // Keep the upstream WebSocket in CONNECTING so every worker frame uses
      // the relay's bounded pending queue rather than an OS socket buffer.
      onUpstreamUpgrade: () => undefined,
    });
    const client = await connect(relay.socketPath);
    cleanups.push(async () => client.terminate());

    const closed = waitForClose(client);
    client.send(Buffer.alloc(WORKER_PROTOCOL_MAX_PAYLOAD_BYTES));
    client.send(Buffer.alloc(WORKER_PROTOCOL_MAX_PAYLOAD_BYTES));
    client.send(Buffer.from([0]));

    await expect(closed).resolves.toBe(1008);
  });

  it("closes both peers when a downstream client is over the bounded output limit", async () => {
    const { relay, upstreamClients } = await relayHarness();
    const client = await connect(relay.socketPath);
    cleanups.push(async () => client.terminate());
    await vi.waitFor(() => expect(upstreamClients).toHaveLength(1));
    const bufferedAmount = vi
      .spyOn(WebSocket.prototype, "bufferedAmount", "get")
      .mockReturnValue(WORKER_PROTOCOL_MAX_PAYLOAD_BYTES * 2 + 1);
    const closed = waitForClose(client);
    try {
      upstreamClients[0].send(Buffer.from("gateway-frame"));

      await expect(closed).resolves.toBe(1008);
      expect(bufferedAmount).toHaveBeenCalled();
    } finally {
      bufferedAmount.mockRestore();
    }
  });

  it("closes the worker when the upstream connection fails", async () => {
    const { relay } = await relayHarness({
      onUpstreamUpgrade: (socket) => {
        socket.end("HTTP/1.1 503 Upstream unavailable\r\nConnection: close\r\n\r\n");
      },
    });
    const client = await connect(relay.socketPath);
    cleanups.push(async () => client.terminate());

    await expect(waitForClose(client)).resolves.toBe(1008);
  });

  it("terminates live peers and removes the Unix socket on close", async () => {
    const { relay } = await relayHarness();
    const client = await connect(relay.socketPath);
    const closed = waitForClose(client);

    await relay.close();

    await expect(closed).resolves.toEqual(expect.any(Number));
    await expect(fs.lstat(relay.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(expectConnectFailure(relay.socketPath)).resolves.toBeUndefined();
    await expect(relay.close()).resolves.toBeUndefined();
  });
});
