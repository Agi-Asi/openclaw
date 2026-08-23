import { randomUUID } from "node:crypto";
import type { SessionsPatchParams } from "../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../config/sessions.js";

const EXECUTION_AUTHORITY_PATCH_FIELDS = [
  "permissionMode",
  "elevatedLevel",
  "execHost",
  "execSecurity",
  "execAsk",
  "execNode",
  "toolOverrides",
  "inheritedToolPolicyVersion",
  "inheritedToolAllow",
  "inheritedToolDeny",
] as const;

type SessionExecutionAuthorityField = (typeof EXECUTION_AUTHORITY_PATCH_FIELDS)[number];

export function executionAuthorityPatchFields(
  patch: SessionsPatchParams,
): SessionExecutionAuthorityField[] {
  return EXECUTION_AUTHORITY_PATCH_FIELDS.filter((field) => Object.hasOwn(patch, field));
}

export function isExecutionAuthorityPatch(patch: SessionsPatchParams): boolean {
  return EXECUTION_AUTHORITY_PATCH_FIELDS.some((field) => Object.hasOwn(patch, field));
}

export function resolveExecutionAuthorityChange(
  entry: SessionEntry,
  projected: SessionEntry,
  patch: SessionsPatchParams,
): boolean {
  return EXECUTION_AUTHORITY_PATCH_FIELDS.some((field) => {
    if (!Object.hasOwn(patch, field)) {
      return false;
    }
    return JSON.stringify(entry[field]) !== JSON.stringify(projected[field]);
  });
}

export function rotateExecutionAuthorityRevision(
  entry: SessionEntry,
  previous: SessionEntry | undefined,
  patch: SessionsPatchParams,
): SessionEntry {
  return previous && resolveExecutionAuthorityChange(previous, entry, patch)
    ? { ...entry, lifecycleRevision: randomUUID() }
    : entry;
}
