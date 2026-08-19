import net from "node:net";

const socketPath = process.env.OPENCLAW_MEMORY_BROKER_TEST_SOCKET;
const brokerEpoch = process.env.OPENCLAW_MEMORY_BROKER_TEST_EPOCH;
if (!socketPath || !brokerEpoch) {
  process.exitCode = 1;
  throw new Error("missing memory broker test socket");
}

const request = { method: "memory.search", payload: { query: "other tenant" } };
const envelope = {
  version: 1,
  brokerId: "broker-a",
  brokerEpoch,
  binding: {
    agentId: "agent-b",
    sessionId: "session-b",
    runId: "run-b",
    contextFingerprint: "context-b",
    subjectRevision: "subject-b",
    actor: { kind: "principal", actorKind: "human", principalId: "mallory" },
    actorRevision: "actor-b",
    capabilitySnapshotId: "capability-b",
    policyRevision: "policy-b",
    deliveryRevision: "delivery-b",
  },
  nonce: "forged-nonce",
  issuedAtMs: Date.now(),
  expiresAtMs: Date.now() + 30_000,
  requestDigest: "forged-digest",
  signature: "forged-signature",
};

const socket = net.createConnection(socketPath);
let response = "";
socket.setEncoding("utf8");
socket.once("connect", () => socket.end(`${JSON.stringify({ envelope, request })}\n`));
socket.on("data", (chunk) => {
  response += chunk;
});
socket.once("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
socket.once("close", () => {
  process.stdout.write(response);
});
