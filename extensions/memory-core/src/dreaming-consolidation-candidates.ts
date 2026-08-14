import type {
  PromotionCandidate,
  ShortTermPromotionAuthorizedView,
} from "./short-term-promotion-types.js";
import { isShortTermSessionCorpusPath } from "./short-term-promotion-utils.js";

export function filterConsolidationCandidates(
  candidates: readonly PromotionCandidate[],
): PromotionCandidate[] {
  return candidates.filter(isConsolidationCandidateEligible);
}

/** Explicitly tainted origins must never promote through any durable write path. */
export function isPromotionOriginBlocked(candidate: PromotionCandidate): boolean {
  const originClass = candidate.provenance?.originClass;
  return originClass === "untrusted" || originClass === "system";
}

function authorizedViewIdentity(view: ShortTermPromotionAuthorizedView): string {
  return `${view.storeId}\u0000${view.viewId}`;
}

/** A scoped candidate can promote only from one active, immutable authorized view. */
export function isPromotionAuthorizedViewBlocked(
  candidate: Pick<PromotionCandidate, "authorizedView">,
): boolean {
  const view = candidate.authorizedView;
  return Boolean(
    view &&
      (typeof view.storeId !== "string" ||
        typeof view.viewId !== "string" ||
        typeof view.resourceRevision !== "string" ||
        !view.storeId.trim() ||
        !view.viewId.trim() ||
        !view.resourceRevision.trim() ||
        view.lifecycle !== "active"),
  );
}

/** Legacy records lack a scoped view; if one is present, never mix it with another view or legacy data. */
export function hasOnePromotionAuthorizedView(candidates: readonly PromotionCandidate[]): boolean {
  const scoped = candidates.filter((candidate) => candidate.authorizedView);
  if (scoped.length === 0) {
    return true;
  }
  if (scoped.length !== candidates.length || scoped.some(isPromotionAuthorizedViewBlocked)) {
    return false;
  }
  return new Set(scoped.map((candidate) => authorizedViewIdentity(candidate.authorizedView!))).size === 1;
}

/**
 * Dreaming may process legacy workspace records together, but a scoped record
 * changes the boundary: a phase gets one active authorized view or no input.
 * That prevents a narrative/consolidation model context from joining stores.
 */
export function filterToOnePromotionAuthorizedView<
  Candidate extends Pick<PromotionCandidate, "authorizedView">,
>(candidates: readonly Candidate[]): Candidate[] {
  const eligible = candidates.filter((candidate) => !isPromotionAuthorizedViewBlocked(candidate));
  const scoped = eligible.filter((candidate) => candidate.authorizedView);
  if (scoped.length === 0) {
    return eligible;
  }
  if (scoped.length !== eligible.length) {
    return [];
  }
  const identities = new Set(
    scoped.map((candidate) => authorizedViewIdentity(candidate.authorizedView!)),
  );
  return identities.size === 1 ? eligible : [];
}

export function isConsolidationCandidateEligible(candidate: PromotionCandidate): boolean {
  const trustedOrigin =
    candidate.provenance?.originClass === "owner" || candidate.provenance?.originClass === "agent";
  const normalizedPath = candidate.path.replaceAll("\\", "/");
  const sessionDerived =
    isShortTermSessionCorpusPath(normalizedPath) || normalizedPath.startsWith("sessions/");
  return trustedOrigin && (!sessionDerived || candidate.provenance?.sessionKind === "interactive");
}
