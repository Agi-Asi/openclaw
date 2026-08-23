import { html, nothing, type TemplateResult } from "lit";
import { t } from "../i18n/index.ts";
import { icons } from "./icons.ts";
import { menuShortcutHint } from "./menu-shortcuts.ts";
import { renderCompactSessionMenuNavigationItem } from "./session-menu-compact.ts";
import type { SessionPinMenuAction } from "./session-menu-pin-actions.ts";

export function renderSessionMenuMoreActions(params: {
  groupPinAction: SessionPinMenuAction | null;
  pinDisabled: boolean;
  pinDisabledReason?: string;
  ownerAvailable: boolean;
  ownerDisabled: boolean;
  ownerDisabledReason?: string;
  iconDisabled: boolean;
  iconDisabledReason?: string;
  forkDisabled: boolean;
  forkDisabledReason?: string;
  forkLabel: string;
  sessionIdAvailable: boolean;
  workboard: { captured: boolean; busy: boolean } | null;
  menuDisabled: boolean;
}): TemplateResult {
  const groupPin = params.groupPinAction;
  return html`
    <div class="session-menu__info">${t("sessionsView.moreActions")}</div>
    ${groupPin
      ? html`
          <wa-dropdown-item
            class="session-menu__item"
            value=${`pin-scope:${groupPin.scope ?? "none"}`}
            ?disabled=${params.pinDisabled}
            title=${params.pinDisabledReason ?? nothing}
          >
            <span slot="icon" class="session-menu__icon" aria-hidden="true"
              >${groupPin.scope === null ? icons.pinOff : icons.folder}</span
            >
            <span class="session-menu__text">${groupPin.label}</span>
          </wa-dropdown-item>
          <div class="session-menu__separator" role="separator"></div>
        `
      : nothing}
    ${params.ownerAvailable
      ? renderCompactSessionMenuNavigationItem({
          view: "assign-owner",
          label: t("sessionsView.assignTo"),
          icon: icons.users,
          disabled: params.ownerDisabled,
          title: params.ownerDisabledReason,
        })
      : nothing}
    ${renderCompactSessionMenuNavigationItem({
      view: "icon",
      label: t("sessionsView.setIconMenu"),
      icon: icons.star,
      disabled: params.iconDisabled,
      title: params.iconDisabledReason,
      shortcut: "i",
    })}
    <wa-dropdown-item
      class="session-menu__item"
      value="fork"
      data-shortcut="f"
      aria-keyshortcuts="F"
      ?disabled=${params.forkDisabled}
      title=${params.forkDisabledReason ?? nothing}
    >
      <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.copy}</span>
      <span class="session-menu__text">${params.forkLabel}</span>
      ${menuShortcutHint("f")}
    </wa-dropdown-item>
    <wa-dropdown-item
      class="session-menu__item"
      value="copy-session-id"
      data-shortcut="c"
      aria-keyshortcuts="C"
      ?disabled=${!params.sessionIdAvailable}
    >
      <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.copy}</span>
      <span class="session-menu__text">${t("sessionsView.copySessionId")}</span>
      ${menuShortcutHint("c")}
    </wa-dropdown-item>
    ${params.workboard
      ? html`
          <wa-dropdown-item
            class="session-menu__item"
            value="workboard"
            data-shortcut="w"
            aria-keyshortcuts="W"
            ?disabled=${params.menuDisabled || params.workboard.busy}
          >
            <span slot="icon" class="session-menu__icon" aria-hidden="true"
              >${params.workboard.captured ? icons.check : icons.plus}</span
            >
            <span class="session-menu__text"
              >${params.workboard.captured
                ? t("sessionsView.openWorkboardCard")
                : t("sessionsView.addToWorkboard")}</span
            >
            ${menuShortcutHint("w")}
          </wa-dropdown-item>
        `
      : nothing}
  `;
}
