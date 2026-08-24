import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeCronRuntimeAuthority,
  normalizeCronScheduledToolBindings,
  type CronRuntimeAuthority,
  type CronScheduledToolBinding,
} from "../cron/runtime-authority.js";
import type { AnyAgentTool } from "./tools/common.js";

type CronScheduledToolProjection = Readonly<{
  assertActive: () => void;
  binding: CronScheduledToolBinding;
  execute: AnyAgentTool["execute"];
}>;

export type CronScheduledToolAuthorityCapture = Readonly<{
  kind: "cron-scheduled-tool-authority-capture";
}>;

const scheduledToolProjections = new WeakMap<AnyAgentTool, CronScheduledToolProjection>();
const scheduledToolAuthorityCaptures = new WeakMap<
  CronScheduledToolAuthorityCapture,
  Readonly<{
    projections: readonly CronScheduledToolProjection[];
    fallbackAuthority: CronRuntimeAuthority;
  }>
>();

const EXEC_POLICY_PARAMETER_NAMES = new Set(["host", "security", "ask"]);
const NODE_EXEC_PARAMETER_NAMES = new Set(["command", "workdir", "env", "timeoutSeconds", "node"]);

type PinnedExecToolTarget = { host: "gateway"; ask?: "always" } | { host: "node"; node?: string };

/** Core-only producer boundary for an alias of an exact host-created shell tool. */
export function sealCronScheduledToolProjection(
  projectedTool: AnyAgentTool,
  assertActive: () => void,
  targetTool: "exec" | "process",
): AnyAgentTool {
  assertActive();
  const binding: CronScheduledToolBinding =
    targetTool === "exec"
      ? {
          sourceTool: projectedTool.name,
          targetTool: "exec",
          execTarget: { host: "gateway" },
        }
      : { sourceTool: projectedTool.name, targetTool: "process" };
  scheduledToolProjections.set(
    projectedTool,
    Object.freeze({ assertActive, binding, execute: projectedTool.execute }),
  );
  return projectedTool;
}

export function copyCronScheduledToolProjection(source: AnyAgentTool, target: AnyAgentTool): void {
  const projection = scheduledToolProjections.get(source);
  if (
    projection &&
    source.name === projection.binding.sourceTool &&
    target.name === projection.binding.sourceTool &&
    source.execute === projection.execute &&
    target.execute === projection.execute
  ) {
    scheduledToolProjections.set(target, projection);
  }
}

/** Captures only host-sealed projections present on the final executable surface. */
export function captureCronScheduledToolAuthority(
  tools: readonly AnyAgentTool[],
  fallbackAuthority: CronRuntimeAuthority,
): CronScheduledToolAuthorityCapture | undefined {
  const projections = tools.flatMap((tool) => {
    const projection = scheduledToolProjections.get(tool);
    if (!projection) {
      return [];
    }
    projection.assertActive();
    if (tool.name !== projection.binding.sourceTool || tool.execute !== projection.execute) {
      throw new Error("scheduled tool projection executable changed after host sealing");
    }
    return [projection];
  });
  const bindings = normalizeCronScheduledToolBindings(
    projections.map((projection) => projection.binding),
  );
  const normalizedFallback = normalizeCronRuntimeAuthority(fallbackAuthority);
  if (projections.length === 0) {
    return undefined;
  }
  if (!bindings || !normalizedFallback) {
    throw new Error("scheduled tool projection capture is invalid");
  }
  const capture = Object.freeze({
    kind: "cron-scheduled-tool-authority-capture" as const,
  });
  scheduledToolAuthorityCaptures.set(
    capture,
    Object.freeze({
      projections: Object.freeze(projections),
      fallbackAuthority: normalizedFallback,
    }),
  );
  return capture;
}

/** Redeems host-owned evidence immediately before minting the one-shot cron grant. */
export function redeemCronScheduledToolAuthority(
  capture: CronScheduledToolAuthorityCapture | undefined,
  authority: CronRuntimeAuthority | undefined,
): CronRuntimeAuthority | undefined {
  if (!capture) {
    return authority;
  }
  const captured = scheduledToolAuthorityCaptures.get(capture);
  if (!captured) {
    throw new Error("scheduled tool authority capture is not host-issued");
  }
  for (const projection of captured.projections) {
    projection.assertActive();
  }
  const runtimeAuthority = authority ?? captured.fallbackAuthority;
  const normalized = normalizeCronRuntimeAuthority({
    ...runtimeAuthority,
    toolBindings: captured.projections.map((projection) => projection.binding),
  });
  if (!normalized) {
    throw new Error("scheduled tool authority redemption is invalid");
  }
  return normalized;
}

/** Restricts an exec tool to one host target even when callers submit broader arguments. */
export function pinExecToolTarget(tool: AnyAgentTool, target: PinnedExecToolTarget): AnyAgentTool {
  const pinnedNode = target.host === "node" ? target.node?.trim() : undefined;
  return {
    ...tool,
    parameters: restrictExecToolParameters(tool.parameters, target.host, Boolean(pinnedNode)),
    execute: (toolCallId, args, signal, onUpdate) =>
      tool.execute(toolCallId, pinExecToolArgs(args, target, pinnedNode), signal, onUpdate),
  };
}

function pinExecToolArgs(
  args: unknown,
  target: PinnedExecToolTarget,
  pinnedNode: string | undefined,
): Record<string, unknown> {
  const source = asNonArrayRecord(args);
  const { host: _host, security: _security, ask: _ask, node: requestedNode, ...rest } = source;
  if (target.host === "gateway") {
    return { ...rest, host: "gateway", ...(target.ask ? { ask: target.ask } : {}) };
  }
  const nodeArgs = Object.fromEntries(
    Object.entries(rest).filter(([name]) => NODE_EXEC_PARAMETER_NAMES.has(name)),
  );
  const node = pinnedNode ?? (typeof requestedNode === "string" ? requestedNode.trim() : "");
  return {
    ...nodeArgs,
    host: "node",
    ...(node ? { node } : {}),
  };
}

function restrictExecToolParameters(
  parameters: AnyAgentTool["parameters"],
  host: PinnedExecToolTarget["host"],
  hasPinnedNode: boolean,
): AnyAgentTool["parameters"] {
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    return parameters;
  }
  // SAFETY: the guards above establish a non-array object schema before field inspection.
  const schema = parameters as Record<string, unknown>;
  const rawProperties = schema.properties;
  if (!rawProperties || typeof rawProperties !== "object" || Array.isArray(rawProperties)) {
    return parameters;
  }
  const includeParameter = (name: string) =>
    host === "node"
      ? NODE_EXEC_PARAMETER_NAMES.has(name) && !(hasPinnedNode && name === "node")
      : !EXEC_POLICY_PARAMETER_NAMES.has(name) && name !== "node";
  const properties = Object.fromEntries(
    Object.entries(rawProperties).filter(([name]) => includeParameter(name)),
  );
  const rawRequired = schema.required;
  const required = Array.isArray(rawRequired)
    ? rawRequired.filter((name) => typeof name !== "string" || includeParameter(name))
    : rawRequired;
  return {
    ...schema,
    properties,
    ...(Array.isArray(rawRequired) ? { required } : {}),
    // SAFETY: this preserves the original schema shape and only removes properties and required names.
  } as AnyAgentTool["parameters"];
}
