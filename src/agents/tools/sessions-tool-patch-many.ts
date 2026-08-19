import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionsPatchManyResult } from "../../../packages/gateway-protocol/src/index.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { readToolStringParam, ToolAuthorizationError, ToolInputError } from "./common.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";

const PATCH_MANY_ERROR_MAX_CHARS = 240;
const RESULT_OMITTED_REASON = "response_budget_exceeded";
const UNSUPPORTED_PATCH_MANY_FIELDS = [
  "label",
  "icon",
  "statusNote",
  "attention",
  "ttlMinutes",
  "pinned",
  "archived",
  "model",
  "thinkingLevel",
] as const;

type ResolvedPatchTarget = {
  agentId: string;
  expectedSessionId?: string;
  key: string;
};

function readPatchCategory(params: Record<string, unknown>): string | null | undefined {
  const value = params.category;
  if (value === undefined || value === null) {
    return value;
  }
  if (typeof value !== "string") {
    throw new ToolInputError("category must be a string");
  }
  return value.trim() || null;
}

function readPatchUnread(params: Record<string, unknown>): boolean | undefined {
  const value = params.unread;
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new ToolInputError("unread must be boolean");
  }
  return value;
}

export async function executeSessionsPatchMany(params: {
  raw: Record<string, unknown>;
  callGateway: AgentToolGatewayRequestCaller;
  resolveTarget: (sessionKey: string) => Promise<ResolvedPatchTarget>;
  resultFitsBudget: (payload: Record<string, unknown>) => boolean;
}): Promise<Record<string, unknown>> {
  const targetsInput = params.raw.targets;
  if (!Array.isArray(targetsInput) || targetsInput.length === 0) {
    throw new ToolInputError("patch_many requires targets");
  }
  if (targetsInput.length > 100) {
    throw new ToolInputError("patch_many supports at most 100 targets");
  }
  for (const field of UNSUPPORTED_PATCH_MANY_FIELDS) {
    if (params.raw[field] !== undefined) {
      throw new ToolInputError(`patch_many does not support ${field}`);
    }
  }
  const category = readPatchCategory(params.raw);
  const unread = readPatchUnread(params.raw);
  const patch = {
    ...(category !== undefined ? { category } : {}),
    ...(unread !== undefined ? { unread } : {}),
  };
  if (Object.keys(patch).length === 0) {
    throw new ToolInputError("patch_many requires category or unread");
  }
  const targets = await Promise.all(
    targetsInput.map(async (rawTarget, index) => {
      if (!isRecord(rawTarget)) {
        throw new ToolInputError(`targets[${index}] must be an object`);
      }
      const sessionKey = readToolStringParam(rawTarget, "sessionKey", { required: true });
      const resolved = await params.resolveTarget(sessionKey);
      const requestedSessionId = normalizeOptionalString(
        readToolStringParam(rawTarget, "expectedSessionId"),
      );
      if (
        requestedSessionId &&
        resolved.expectedSessionId &&
        requestedSessionId !== resolved.expectedSessionId
      ) {
        throw new ToolAuthorizationError(`Session changed after access was granted: ${sessionKey}`);
      }
      const expectedSessionId = requestedSessionId ?? resolved.expectedSessionId;
      const target: { key: string; agentId?: string; expectedSessionId?: string } = {
        key: resolved.key,
      };
      if (!parseAgentSessionKey(resolved.key)) {
        target.agentId = resolved.agentId;
      }
      if (expectedSessionId) {
        target.expectedSessionId = expectedSessionId;
      }
      return target;
    }),
  );
  const result = await params.callGateway<SessionsPatchManyResult>({
    method: "sessions.patchMany",
    params: { targets, patch },
  });
  const failed = result.outcomes.flatMap((outcome) =>
    outcome.ok
      ? []
      : [
          {
            sessionKey: outcome.key,
            error: outcome.error.message.slice(0, PATCH_MANY_ERROR_MAX_CHARS),
          },
        ],
  );
  const updated = result.outcomes.length - failed.length;
  const status = updated === 0 ? "failed" : failed.length > 0 ? "partial" : "updated";
  const acknowledgement = { status, requested: targets.length, updated, failed };
  return params.resultFitsBudget(acknowledgement)
    ? acknowledgement
    : {
        status,
        requested: targets.length,
        updated,
        failedOmitted: { count: failed.length, reason: RESULT_OMITTED_REASON },
      };
}
