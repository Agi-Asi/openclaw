import type { SessionPinScope } from "../../../packages/gateway-protocol/src/index.ts";
import { t } from "../i18n/index.ts";

export type SessionPinMenuAction = {
  label: string;
  scope: SessionPinScope | null;
};

export function globalSessionPinAction(scope: SessionPinScope | null): SessionPinMenuAction {
  if (scope === "global") {
    return { label: t("sessionsView.unpinGlobally"), scope: null };
  }
  return {
    label: t(scope === "group" ? "sessionsView.movePinGlobally" : "sessionsView.pinGlobally"),
    scope: "global",
  };
}

export function groupSessionPinAction(params: {
  category: string | null;
  categoryPinAvailable: boolean;
  scope: SessionPinScope | null;
}): SessionPinMenuAction | null {
  if (!params.category) {
    return null;
  }
  if (params.scope === "group") {
    return {
      label: t("sessionsView.unpinFromGroup", { group: params.category }),
      scope: null,
    };
  }
  if (!params.categoryPinAvailable) {
    return null;
  }
  return {
    label: t(
      params.scope === "global" ? "sessionsView.movePinToGroup" : "sessionsView.pinInGroup",
      {
        group: params.category,
      },
    ),
    scope: "group",
  };
}
