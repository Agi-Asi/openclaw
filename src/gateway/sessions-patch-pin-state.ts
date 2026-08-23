import type { SessionsPatchParams } from "../../packages/gateway-protocol/src/index.js";
import type { InternalSessionEntry } from "../config/sessions.js";

/** Apply the legacy global pin and additive group-pin contract in one owner. */
export function applySessionsPatchPinState(params: {
  next: InternalSessionEntry;
  patch: Pick<SessionsPatchParams, "pinned" | "pinScope">;
  now: number;
}): string | undefined {
  const { next, patch, now } = params;
  if ("pinned" in patch && "pinScope" in patch) {
    return "pinned and pinScope cannot be set together";
  }
  if ("pinned" in patch) {
    if (patch.pinned === true) {
      if (next.archivedAt !== undefined) {
        return "cannot pin an archived session; restore it first";
      }
      next.pinnedAt ??= now;
      delete next.categoryPinnedAt;
    } else {
      delete next.pinnedAt;
      delete next.categoryPinnedAt;
    }
  }
  if (!("pinScope" in patch)) {
    return undefined;
  }
  if (patch.pinScope === "global") {
    if (next.archivedAt !== undefined) {
      return "cannot pin an archived session; restore it first";
    }
    next.pinnedAt ??= now;
    delete next.categoryPinnedAt;
  } else if (patch.pinScope === "group") {
    if (next.archivedAt !== undefined) {
      return "cannot pin an archived session; restore it first";
    }
    if (!next.category?.trim()) {
      return "cannot pin within a group before assigning the session to a group";
    }
    next.categoryPinnedAt ??= now;
    delete next.pinnedAt;
  } else {
    delete next.pinnedAt;
    delete next.categoryPinnedAt;
  }
  return undefined;
}
