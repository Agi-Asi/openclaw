import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { closedObject } from "./closed-object.js";
import {
  LiveIntegerSchema,
  WorkerErrorResponseFrameSchema,
  WorkerFrameIdSchema,
  WorkerIdentifierSchema,
  WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
} from "./worker-protocol-primitives.js";

/** Additive, exact-build worker feature. Workers never receive memory authority or a store id. */
export const WORKER_MEMORY_PROTOCOL_FEATURE = "worker-memory-v1";
export const WORKER_MEMORY_METHODS = ["worker.memory.search", "worker.memory.read"] as const;

export const WorkerMemorySearchParamsSchema = closedObject({
  query: Type.String({ minLength: 1, maxLength: WORKER_PROTOCOL_MAX_PAYLOAD_BYTES }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

export const WorkerMemoryReadParamsSchema = closedObject({
  handleId: WorkerIdentifierSchema,
  from: Type.Optional(LiveIntegerSchema),
  lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
});

const WorkerMemorySearchSuccessResponseFrameSchema = closedObject({
  type: Type.Literal("res"),
  id: WorkerFrameIdSchema,
  ok: Type.Literal(true),
  // Search hits are selected-runtime DTOs. The generic worker protocol authenticates the
  // operation and bounds the frame; it must not learn plugin storage or index schemas.
  payload: Type.Unknown(),
});

const WorkerMemoryReadSuccessResponseFrameSchema = closedObject({
  type: Type.Literal("res"),
  id: WorkerFrameIdSchema,
  ok: Type.Literal(true),
  payload: Type.Unknown(),
});

export const WorkerMemorySearchResponseFrameSchema = Type.Union([
  WorkerMemorySearchSuccessResponseFrameSchema,
  WorkerErrorResponseFrameSchema,
]);
export const WorkerMemoryReadResponseFrameSchema = Type.Union([
  WorkerMemoryReadSuccessResponseFrameSchema,
  WorkerErrorResponseFrameSchema,
]);

export type WorkerMemorySearchParams = Static<typeof WorkerMemorySearchParamsSchema>;
export type WorkerMemoryReadParams = Static<typeof WorkerMemoryReadParamsSchema>;
export type WorkerMemorySearchResponseFrame = Static<typeof WorkerMemorySearchResponseFrameSchema>;
export type WorkerMemoryReadResponseFrame = Static<typeof WorkerMemoryReadResponseFrameSchema>;

export function validateWorkerMemorySearchParams(
  value: unknown,
): value is WorkerMemorySearchParams {
  return Value.Check(WorkerMemorySearchParamsSchema, value);
}

export function validateWorkerMemoryReadParams(value: unknown): value is WorkerMemoryReadParams {
  return Value.Check(WorkerMemoryReadParamsSchema, value);
}
