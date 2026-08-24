import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { isDetachedSessionCreationAuthority } from "../cron-creator-authority-grant.js";
import type { TrustedSessionCreation } from "./session-creation-provenance.js";

export class DetachedSessionAuthorityExpiredError extends TypeError {}

export function resolveDetachedSessionAuthority(params: {
  creation: TrustedSessionCreation;
  hasInitialTurn: boolean;
  parentSessionKey?: string;
  spawnDepth?: number;
  fork?: boolean;
  forkFrom?: "last-completed";
  succeedsParent?: boolean;
  permissionMode?: string;
}) {
  const supplied = params.creation.detachedAuthority;
  if (!supplied) {
    return { authority: undefined };
  }
  if (!isDetachedSessionCreationAuthority(supplied)) {
    return {
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Detached session creation authority is invalid.",
      ),
    };
  }
  const hasLineage =
    params.parentSessionKey !== undefined ||
    params.spawnDepth !== undefined ||
    params.fork === true ||
    params.forkFrom !== undefined ||
    params.succeedsParent !== undefined;
  if (
    params.creation.via !== "operator" ||
    params.creation.actor?.type !== "agent" ||
    hasLineage ||
    params.hasInitialTurn
  ) {
    return {
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Detached session creation cannot include parent, spawn, fork, successor, or initial-turn state.",
      ),
    };
  }
  if (params.permissionMode === "full" && !supplied.admin) {
    return {
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "permissionMode full requires an admitted local administrator turn. Ask an administrator to create the full session.",
      ),
    };
  }
  try {
    supplied.assertActive();
  } catch {
    return {
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Detached session creation authority is no longer active. Retry from a new direct operator turn.",
      ),
    };
  }
  return {
    authority: supplied,
    assertActive: () => {
      try {
        supplied.assertActive();
      } catch {
        throw new DetachedSessionAuthorityExpiredError(
          "Detached session creation authority is no longer active. Retry from a new direct operator turn.",
        );
      }
    },
  };
}
