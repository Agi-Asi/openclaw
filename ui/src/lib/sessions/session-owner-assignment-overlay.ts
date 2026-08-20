import type { SessionOwner } from "../../../../packages/gateway-protocol/src/index.js";
import type { SessionsListResult } from "../../api/types.ts";

type ConfirmedOwnerClaim = {
  owner: SessionOwner;
  sessionId?: string;
};

function ownersMatch(left: SessionOwner | undefined, right: SessionOwner): boolean {
  return (
    left?.actor.type === right.actor.type &&
    left.actor.id === right.actor.id &&
    left.assignedBy?.type === right.assignedBy?.type &&
    left.assignedBy?.id === right.assignedBy?.id &&
    left.assignedAt === right.assignedAt
  );
}

export function createSessionOwnerAssignmentOverlay() {
  const claims = new Map<string, ConfirmedOwnerClaim>();

  return {
    confirm(key: string, owner: SessionOwner, sessionId?: string): ConfirmedOwnerClaim {
      const claim = { owner, ...(sessionId ? { sessionId } : {}) };
      claims.set(key, claim);
      return claim;
    },
    isCurrent(key: string, claim: ConfirmedOwnerClaim): boolean {
      return claims.get(key) === claim;
    },
    retire(key: string): void {
      claims.delete(key);
    },
    clear(): void {
      claims.clear();
    },
    decorate(result: SessionsListResult | null): SessionsListResult | null {
      if (!result || claims.size === 0) {
        return result;
      }
      let changed = result.owners !== undefined;
      const sessions = result.sessions.map((row) => {
        const claim = claims.get(row.key);
        if (!claim) {
          return row;
        }
        if (claim.sessionId && row.sessionId && claim.sessionId !== row.sessionId) {
          claims.delete(row.key);
          return row;
        }
        if (ownersMatch(row.owner, claim.owner)) {
          return row;
        }
        changed = true;
        return { ...row, owner: claim.owner };
      });
      return changed ? { ...result, sessions, owners: undefined } : result;
    },
    observeCanonical(result: SessionsListResult | null): void {
      for (const row of result?.sessions ?? []) {
        const claim = claims.get(row.key);
        if (
          claim &&
          ((claim.sessionId && row.sessionId && claim.sessionId !== row.sessionId) ||
            ownersMatch(row.owner, claim.owner))
        ) {
          claims.delete(row.key);
        }
      }
    },
  };
}
