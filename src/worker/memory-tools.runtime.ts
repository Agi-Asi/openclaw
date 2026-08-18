import { Type } from "typebox";
import {
  asToolParamsRecord,
  jsonResult,
  readPositiveIntegerParam,
  readToolStringParam,
  type AnyAgentTool,
} from "../agents/tools/common.js";
import type { WorkerMemoryClient } from "./worker-rpc-memory-client.js";

const MemorySearchSchema = Type.Object({
  query: Type.String({ minLength: 1 }),
  maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

const MemoryGetSchema = Type.Object({
  handleId: Type.String({ minLength: 1 }),
  from: Type.Optional(Type.Integer({ minimum: 1 })),
  lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
});

const unavailable = () =>
  jsonResult({
    disabled: true,
    unavailable: true,
    error: "memory unavailable",
    action: "Continue without memory or retry after the Gateway worker connection recovers.",
  });

/**
 * These tools are process-local adapters only. Gateway owns subject/capability derivation and
 * broker IPC; the worker sends model arguments plus its already-authenticated connection identity.
 */
export function createWorkerMemoryTools(client: WorkerMemoryClient): readonly AnyAgentTool[] {
  return [
    {
      label: "Memory Search",
      name: "memory_search",
      description:
        "Search the memory view authorized for this turn. Results return opaque handleId values; use memory_get to read one result.",
      parameters: MemorySearchSchema,
      execute: async (_toolCallId, params) => {
        const values = asToolParamsRecord(params);
        const query = readToolStringParam(values, "query", { required: true });
        const limit = readPositiveIntegerParam(values, "maxResults", { max: 100 });
        const result = await client.search({ query, ...(limit === undefined ? {} : { limit }) });
        return result === undefined ? unavailable() : jsonResult(result);
      },
    },
    {
      label: "Memory Get",
      name: "memory_get",
      description:
        "Read an exact excerpt using an opaque handleId returned by memory_search. Paths and store identifiers are not accepted.",
      parameters: MemoryGetSchema,
      execute: async (_toolCallId, params) => {
        const values = asToolParamsRecord(params);
        const handleId = readToolStringParam(values, "handleId", { required: true });
        const from = readPositiveIntegerParam(values, "from");
        const lines = readPositiveIntegerParam(values, "lines", { max: 10_000 });
        const result = await client.read({
          handleId,
          ...(from === undefined ? {} : { from }),
          ...(lines === undefined ? {} : { lines }),
        });
        return result === undefined ? unavailable() : jsonResult(result);
      },
    },
  ];
}
