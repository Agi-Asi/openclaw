import type { SessionPinScope } from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewaySessionRow } from "../../api/types.ts";

type ResolvedSessionPinScope = SessionPinScope | null;

export type OptimisticSessionPinFields = Pick<
  GatewaySessionRow,
  "categoryPinnedAt" | "pinned" | "pinnedAt"
>;

function finiteTimestamp(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function resolveGatewaySessionPinScope(
  row: Pick<GatewaySessionRow, "category" | "categoryPinnedAt" | "pinned" | "pinnedAt">,
): ResolvedSessionPinScope {
  if (row.pinned === true) {
    return "global";
  }
  return row.category?.trim() && finiteTimestamp(row.categoryPinnedAt) !== undefined
    ? "group"
    : null;
}

/** Preserve the active scope's timestamp while optimistic UI state is pending. */
export function optimisticSessionPinFields(
  scope: SessionPinScope | null,
  row?: Pick<GatewaySessionRow, "category" | "categoryPinnedAt" | "pinned" | "pinnedAt">,
): OptimisticSessionPinFields {
  const currentScope = row ? resolveGatewaySessionPinScope(row) : null;
  if (scope === "global") {
    return {
      pinned: true,
      pinnedAt: currentScope === scope ? (row?.pinnedAt ?? Date.now()) : Date.now(),
      categoryPinnedAt: undefined,
    };
  }
  if (scope === "group") {
    return {
      pinned: false,
      pinnedAt: undefined,
      categoryPinnedAt: currentScope === scope ? (row?.categoryPinnedAt ?? Date.now()) : Date.now(),
    };
  }
  return { pinned: false, pinnedAt: undefined, categoryPinnedAt: undefined };
}

/** Global pins remain the only pins that reorder the whole session list. */
export function compareGatewaySessionPins(a: GatewaySessionRow, b: GatewaySessionRow): number {
  const aGlobal = resolveGatewaySessionPinScope(a) === "global";
  const bGlobal = resolveGatewaySessionPinScope(b) === "global";
  const scopeOrder = Number(bGlobal) - Number(aGlobal);
  if (scopeOrder !== 0) {
    return scopeOrder;
  }
  const aPinnedAt = aGlobal ? a.pinnedAt : undefined;
  const bPinnedAt = bGlobal ? b.pinnedAt : undefined;
  return (bPinnedAt ?? 0) - (aPinnedAt ?? 0);
}

/** Category sections call this only after partitioning, so local pins never leak globally. */
export function compareGatewaySessionCategoryPins(
  a: Pick<GatewaySessionRow, "categoryPinnedAt">,
  b: Pick<GatewaySessionRow, "categoryPinnedAt">,
): number {
  return (finiteTimestamp(b.categoryPinnedAt) ?? 0) - (finiteTimestamp(a.categoryPinnedAt) ?? 0);
}
