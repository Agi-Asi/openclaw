import fs from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import path from "node:path";
import { WORKER_PROTOCOL_MAX_PAYLOAD_BYTES } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  resolveWorkerConnectionTarget,
  type WorkerConnectionEndpoint,
} from "../worker/worker-connection-endpoint.js";
import { NODE_WORKER_CONTAINER_RELAY_SOCKET } from "./node-worker-container-runtime.js";

const RELAY_PATH = "/";
const RELAY_MAX_PENDING_BYTES = WORKER_PROTOCOL_MAX_PAYLOAD_BYTES * 2;
const RELAY_MAX_BUFFERED_BYTES = WORKER_PROTOCOL_MAX_PAYLOAD_BYTES * 2;
const RELAY_CONNECT_TIMEOUT_MS = 10_000;
const RELAY_PORTABLE_UNIX_SOCKET_MAX_BYTES = 100;

export type NodeWorkerGatewayRelay = Readonly<{
  socketPath: string;
  close: () => Promise<void>;
}>;

function rawBytes(data: RawData): number {
  if (typeof data === "string") {
    return Buffer.byteLength(data, "utf8");
  }
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  }
  return data.byteLength;
}

function rejectUpgrade(socket: Socket, status: number): void {
  socket.end(`HTTP/1.1 ${status} Relay unavailable\r\nConnection: close\r\n\r\n`);
}

/**
 * Exposes one local Unix WebSocket to an isolated worker. The remote Gateway
 * endpoint and any TLS/Cloudflare material remain in this host-side relay.
 */
export async function startNodeWorkerGatewayRelay(params: {
  directory: string;
  upstream: WorkerConnectionEndpoint;
}): Promise<NodeWorkerGatewayRelay> {
  if (!path.isAbsolute(params.directory)) {
    throw new Error("node worker relay directory must be absolute");
  }
  await fs.realpath(params.directory);
  // The bind mount uses the canonical directory, but preserving its short
  // lexical spelling here keeps the live Unix socket below macOS' path limit.
  const socketPath = path.join(params.directory, path.basename(NODE_WORKER_CONTAINER_RELAY_SOCKET));
  if (Buffer.byteLength(socketPath, "utf8") > RELAY_PORTABLE_UNIX_SOCKET_MAX_BYTES) {
    throw new Error("node worker relay socket path exceeds the portable Unix socket limit");
  }
  await fs.rm(socketPath, { force: true });

  let accepted = false;
  let closing = false;
  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
  });
  const server = createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  const sockets = new Set<WebSocket>();

  const stopSocket = (socket: WebSocket, code = 1008) => {
    try {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING) {
        socket.close(code);
        return;
      }
      socket.terminate();
    } catch {
      socket.terminate();
    }
  };

  const attachRelay = (client: WebSocket) => {
    sockets.add(client);
    const target = resolveWorkerConnectionTarget(params.upstream);
    const upstream = new WebSocket(target.url, target.options);
    sockets.add(upstream);
    const pending: Array<{ data: RawData; binary: boolean }> = [];
    let pendingBytes = 0;
    let linked = false;
    let connectTimeout: NodeJS.Timeout | undefined;

    const stopBoth = () => {
      if (linked) {
        linked = false;
      }
      clearTimeout(connectTimeout);
      stopSocket(client);
      stopSocket(upstream);
    };
    const forward = (destination: WebSocket, data: RawData, binary: boolean) => {
      if (destination.readyState !== WebSocket.OPEN || rawBytes(data) > WORKER_PROTOCOL_MAX_PAYLOAD_BYTES) {
        stopBoth();
        return;
      }
      destination.send(data, { binary }, (error) => {
        if (error) {
          stopBoth();
        }
      });
      // WebSocket has no bounded pull API. Terminating both peers on a bounded
      // queue is the relay's backpressure contract; it cannot become a buffer.
      if (destination.bufferedAmount > RELAY_MAX_BUFFERED_BYTES) {
        stopBoth();
      }
    };

    upstream.once("open", () => {
      clearTimeout(connectTimeout);
      const tlsError = target.validateSocket(upstream);
      if (tlsError) {
        stopBoth();
        return;
      }
      linked = true;
      for (const frame of pending.splice(0)) {
        forward(upstream, frame.data, frame.binary);
      }
      pendingBytes = 0;
    });
    connectTimeout = setTimeout(stopBoth, RELAY_CONNECT_TIMEOUT_MS);
    connectTimeout.unref?.();
    upstream.once("error", stopBoth);
    client.once("error", stopBoth);
    upstream.on("message", (data, binary) => forward(client, data, binary));
    client.on("message", (data, binary) => {
      const bytes = rawBytes(data);
      if (bytes > WORKER_PROTOCOL_MAX_PAYLOAD_BYTES) {
        stopBoth();
        return;
      }
      if (!linked) {
        pendingBytes += bytes;
        if (pendingBytes > RELAY_MAX_PENDING_BYTES) {
          stopBoth();
          return;
        }
        pending.push({ data, binary });
        return;
      }
      forward(upstream, data, binary);
    });
    const closePeer = (peer: WebSocket) => () => {
      sockets.delete(peer);
      if (peer.readyState === WebSocket.OPEN || peer.readyState === WebSocket.CLOSING) {
        stopSocket(peer, 1000);
      }
    };
    client.once("close", closePeer(upstream));
    upstream.once("close", closePeer(client));
  };

  server.on("upgrade", (request: IncomingMessage, socket, head) => {
    if (closing || accepted || request.method !== "GET" || request.url !== RELAY_PATH) {
      rejectUpgrade(socket, accepted ? 409 : 404);
      return;
    }
    accepted = true;
    websocketServer.handleUpgrade(request, socket, head, (client) => attachRelay(client));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await fs.chmod(socketPath, 0o600);

  return Object.freeze({
    socketPath,
    close: async () => {
      if (closing) {
        return;
      }
      closing = true;
      for (const socket of sockets) {
        socket.terminate();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(socketPath, { force: true });
      websocketServer.close();
    },
  });
}
