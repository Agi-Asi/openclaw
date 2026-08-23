import type { SessionPinScope } from "../../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "./types.js";

type SessionPinState =
  | { scope: SessionPinScope; pinnedAt: number }
  | { scope: null; pinnedAt: undefined };

function pinTimestamp(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Legacy pinnedAt remains authoritative global state; category pins are orthogonal. */
export function resolveSessionPinState(
  entry: Pick<SessionEntry, "category" | "categoryPinnedAt" | "pinnedAt"> | undefined,
): SessionPinState {
  const globalPinnedAt = pinTimestamp(entry?.pinnedAt);
  if (globalPinnedAt !== undefined) {
    return { scope: "global", pinnedAt: globalPinnedAt };
  }
  const categoryPinnedAt = pinTimestamp(entry?.categoryPinnedAt);
  return entry?.category?.trim() && categoryPinnedAt !== undefined
    ? { scope: "group", pinnedAt: categoryPinnedAt }
    : { scope: null, pinnedAt: undefined };
}
