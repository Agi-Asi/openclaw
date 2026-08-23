// Bounded session-list ordering shared by synchronous and asynchronous projections.

import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import { resolveSessionPinState } from "../config/sessions/pin-scope.js";
import type { SessionEntry } from "../config/sessions/types.js";

const SESSIONS_LIST_TOP_N_LIMIT = 200;

export type SessionEntryPair = [string, SessionEntry];

function compareSessionEntryPairs(
  a: SessionEntryPair,
  b: SessionEntryPair,
  sortBy: SessionsListParams["sortBy"] = "updatedAt",
): number {
  if (sortBy !== "lastInteractionAt") {
    const aPinnedAt = a[1]?.pinnedAt ?? 0;
    const bPinnedAt = b[1]?.pinnedAt ?? 0;
    if (aPinnedAt !== bPinnedAt) {
      return bPinnedAt - aPinnedAt;
    }
  }
  const aTimestamp = sortBy === "lastInteractionAt" ? a[1]?.lastInteractionAt : a[1]?.updatedAt;
  const bTimestamp = sortBy === "lastInteractionAt" ? b[1]?.lastInteractionAt : b[1]?.updatedAt;
  const byTimestamp = (bTimestamp ?? 0) - (aTimestamp ?? 0);
  if (byTimestamp !== 0) {
    return byTimestamp;
  }
  // Stable key ties keep offset paging deterministic across calls.
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

function compareSessionEntrySelectionPairs(
  a: SessionEntryPair,
  b: SessionEntryPair,
  sortBy: SessionsListParams["sortBy"] = "updatedAt",
): number {
  if (sortBy !== "lastInteractionAt") {
    const aPin = resolveSessionPinState(a[1]);
    const bPin = resolveSessionPinState(b[1]);
    const scopeRank = (scope: typeof aPin.scope) =>
      scope === "global" ? 2 : scope === "group" ? 1 : 0;
    const byScope = scopeRank(bPin.scope) - scopeRank(aPin.scope);
    if (byScope !== 0) {
      return byScope;
    }
    if (aPin.pinnedAt !== bPin.pinnedAt) {
      return (bPin.pinnedAt ?? 0) - (aPin.pinnedAt ?? 0);
    }
  }
  return compareSessionEntryPairs(a, b, sortBy);
}

function selectNewestLimitedEntries(
  entries: SessionEntryPair[],
  limit: number,
  sortBy: SessionsListParams["sortBy"],
): SessionEntryPair[] {
  const selected: SessionEntryPair[] = [];
  for (const entry of entries) {
    const insertAt = selected.findIndex(
      (candidate) => compareSessionEntrySelectionPairs(entry, candidate, sortBy) < 0,
    );
    if (insertAt >= 0) {
      selected.splice(insertAt, 0, entry);
      if (selected.length > limit) {
        selected.pop();
      }
    } else if (selected.length < limit) {
      selected.push(entry);
    }
  }
  return selected;
}

export function orderSelectedSessionEntries(
  entries: SessionEntryPair[],
  sortBy: SessionsListParams["sortBy"],
): SessionEntryPair[] {
  return entries.toSorted((a, b) => compareSessionEntryPairs(a, b, sortBy));
}

export function sortAndLimitSessionEntries(
  entries: SessionEntryPair[],
  limit: number | undefined,
  sortBy: SessionsListParams["sortBy"],
): SessionEntryPair[] {
  if (limit !== undefined && limit <= SESSIONS_LIST_TOP_N_LIMIT) {
    return selectNewestLimitedEntries(entries, limit, sortBy);
  }
  if (limit !== undefined) {
    return entries
      .toSorted((a, b) => compareSessionEntrySelectionPairs(a, b, sortBy))
      .slice(0, limit);
  }
  return orderSelectedSessionEntries(entries, sortBy);
}
