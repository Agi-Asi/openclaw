import { describe, expect, it } from "vitest";
import {
  buildNodeWorkerMemoryProjectionRequestProofPayload,
  NODE_WORKER_MEMORY_PROJECTION_MAX_FILE_BYTES,
  parseNodeWorkerMemoryProjection,
  parseNodeWorkerMemoryProjectionPayload,
  parseNodeWorkerMemoryProjectionRequestProof,
} from "./node-memory-projection-protocol.js";

describe("node worker memory projection protocol", () => {
  it("accepts only an opaque projection reference with a bounded node lease", () => {
    expect(
      parseNodeWorkerMemoryProjection({
        version: 1,
        reference: "a".repeat(43),
        binding: { launch: "b".repeat(64), authorization: "c".repeat(64) },
        expiresAtMs: 1_900_000_000_000,
      }),
    ).toEqual({
      version: 1,
      reference: "a".repeat(43),
      binding: { launch: "b".repeat(64), authorization: "c".repeat(64) },
      expiresAtMs: 1_900_000_000_000,
    });
    expect(
      parseNodeWorkerMemoryProjection({
        version: 1,
        reference: "a".repeat(43),
        binding: { launch: "b".repeat(64), authorization: "c".repeat(64) },
        expiresAtMs: 1_900_000_000_000,
        rawPath: "/private/memory.sqlite",
      }),
    ).toBeNull();
    expect(parseNodeWorkerMemoryProjection({ version: 1, reference: "short" })).toBeNull();
  });

  it("canonicalizes only bounded node-host transfer proofs", () => {
    const proof = {
      nodeId: "node-1",
      signedAtMs: 123,
      signature: "a".repeat(86),
    };
    expect(parseNodeWorkerMemoryProjectionRequestProof(proof)).toEqual(proof);
    expect(
      buildNodeWorkerMemoryProjectionRequestProofPayload({
        reference: "a".repeat(43),
        binding: { launch: "b".repeat(64), authorization: "c".repeat(64) },
        nodeId: proof.nodeId,
        signedAtMs: proof.signedAtMs,
      }),
    ).toBe(
      [
        "openclaw.node-worker-memory-projection.request.v1",
        "GET",
        "/__openclaw__/worker-memory-projection/v1/projection",
        "a".repeat(43),
        "b".repeat(64),
        "c".repeat(64),
        "node-1",
        "123",
      ].join("\n"),
    );
    expect(
      parseNodeWorkerMemoryProjectionRequestProof({ ...proof, signature: "short" }),
    ).toBeNull();
    expect(parseNodeWorkerMemoryProjectionRequestProof({ ...proof, extra: true })).toBeNull();
  });

  it.each([
    "shared/../secret.md",
    "shared/child/secret.md",
    "shared\\secret.md",
    "workspace/secret.md",
  ])("rejects a non-isolated virtual path: %s", (virtualPath) => {
    expect(
      parseNodeWorkerMemoryProjectionPayload({
        version: 1,
        files: [
          {
            virtualPath,
            sha256: "a".repeat(64),
            contentBase64: "c2VjcmV0",
          },
        ],
      }),
    ).toBeNull();
  });

  it("accepts the canonical memory view beneath the fixed container mount", () => {
    expect(
      parseNodeWorkerMemoryProjectionPayload({
        version: 1,
        files: [
          {
            virtualPath: "memory/MEMORY.md",
            sha256: "a".repeat(64),
            contentBase64: "c2VjcmV0",
          },
        ],
      }),
    ).toMatchObject({ files: [{ virtualPath: "memory/MEMORY.md" }] });
  });

  it("rejects path collisions and payloads beyond the immutable byte bound", () => {
    const file = {
      virtualPath: "shared/brief.md",
      sha256: "a".repeat(64),
      contentBase64: "c2VjcmV0",
    };
    expect(
      parseNodeWorkerMemoryProjectionPayload({
        version: 1,
        files: [file, { ...file, virtualPath: "SHARED/BRIEF.md" }],
      }),
    ).toBeNull();
    expect(
      parseNodeWorkerMemoryProjectionPayload({
        version: 1,
        files: [
          {
            ...file,
            contentBase64: Buffer.alloc(NODE_WORKER_MEMORY_PROJECTION_MAX_FILE_BYTES + 1).toString(
              "base64",
            ),
          },
        ],
      }),
    ).toBeNull();
  });
});
