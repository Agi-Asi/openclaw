import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import type { SessionPinScope } from "../../../packages/gateway-protocol/src/index.ts";
import { normalizeSessionIconValue } from "../../../packages/gateway-protocol/src/session-agent-status.js";
import { t } from "../i18n/index.ts";
import { EDITOR_IDS, type EditorId } from "../lib/editor-links.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { DropdownMenuController } from "./dropdown-menu-controller.ts";
import { icons } from "./icons.ts";
import { activateMenuShortcut, menuShortcutHint } from "./menu-shortcuts.ts";
import { promoteToPopoverTopLayer } from "./menu-surface.ts";
import { renderSessionIconPicker } from "./session-icon-picker.ts";
import { simpleSessionMenuAction } from "./session-menu-actions.ts";
import {
  compactSessionMenuViewForValue,
  compactSessionOwnerOptions,
  renderCompactSessionMenuNavigationItem,
  renderCompactSessionMenuView,
  type CompactSessionMenuView,
} from "./session-menu-compact.ts";
import { renderSessionMenuMoreActions } from "./session-menu-more-actions.ts";
import {
  renderSessionEditorOptions,
  renderSessionGroupOptions,
  sessionPinScopeFromMenuValue,
} from "./session-menu-options.ts";
import { globalSessionPinAction, groupSessionPinAction } from "./session-menu-pin-actions.ts";
import type { SessionOwnerOption } from "./session-owner-chip.ts";
import { sessionOwnerAssignmentFromMenuValue } from "./session-owner-menu.ts";

type SessionMenuData = {
  label: string;
  sessionId: string | null;
  isChild?: boolean;
  pinScope: SessionPinScope | null;
  unread: boolean;
  archived: boolean;
  category: string | null;
  categoryPinAvailable: boolean;
  icon: string | null;
  categoryClearReturnsToGroups: boolean;
};

/**
 * Worktree-session extras resolved lazily by the menu host after open; null
 * hides the block entirely (plain chat sessions), loading keeps the items
 * rendered-but-disabled so the menu layout never shifts under the pointer.
 * A resolved null `worktreePath` drops the editor row for good — see
 * `native-editor-locality.runtime.ts` for which checkouts ever get one.
 */
export type SessionMenuWork = {
  loading: boolean;
  pullRequestUrl: string | null;
  worktreePath: string | null;
};

export type SessionMenuAction =
  | { kind: "open-pr"; url: string }
  | { kind: "open-in"; editor: EditorId; path: string }
  | { kind: "copy-session-id" }
  | { kind: "set-pin-scope"; scope: SessionPinScope | null }
  | { kind: "toggle-unread" }
  | { kind: "rename" }
  | { kind: "set-icon"; icon: string | null }
  | { kind: "assign-owner"; owner: Pick<SessionOwnerOption, "type" | "id"> }
  | { kind: "fork" }
  | { kind: "workboard" }
  | { kind: "move-to-group"; category: string | null }
  | { kind: "new-group" }
  | { kind: "toggle-archived" }
  | { kind: "stop-cloud-worker" }
  | { kind: "delete" };

export type SessionMenuActionKind = SessionMenuAction["kind"];

const EMPTY_SESSION: SessionMenuData = {
  label: "",
  sessionId: null,
  isChild: false,
  pinScope: null,
  unread: false,
  archived: false,
  category: null,
  categoryPinAvailable: false,
  icon: null,
  categoryClearReturnsToGroups: false,
};

const SESSION_ICON_GRID_COLUMNS = 6;

class SessionMenu extends OpenClawLightDomElement {
  @property({ attribute: false }) session: SessionMenuData = EMPTY_SESSION;
  @property({ attribute: false }) compact = false;
  // >1 renders the batch menu: only actions that apply to every selected
  // session (unread/group/archive/delete); `session` then carries aggregated
  // flags (unread = all unread, category = shared category or null).
  @property({ attribute: false }) selectionCount = 1;
  @property({ attribute: false }) lastActive = "";
  @property({ attribute: false }) anchor: { x: number; y: number } = { x: 0, y: 0 };
  @property({ attribute: false }) trigger: HTMLElement | null = null;
  @property({ attribute: false }) disabled = false;
  @property({ attribute: false }) actionDisabledReasons: Partial<
    Record<SessionMenuActionKind, string>
  > = {};
  @property({ attribute: false }) forkDisabled = false;
  @property({ attribute: false }) forkFromLastCompleted = false;
  @property({ attribute: false }) archiveAllowed = false;
  @property({ attribute: false }) deleteAllowed = false;
  @property({ attribute: false }) cloudWorkerStopAllowed = false;
  @property({ attribute: false }) groups: readonly string[] = [];
  @property({ attribute: false }) ownerOptions: readonly SessionOwnerOption[] = [];
  @property({ attribute: false }) selfOwner: SessionOwnerOption | null = null;
  @property({ attribute: false }) currentOwnerId: string | null = null;
  @property({ attribute: false }) work: SessionMenuWork | null = null;
  @property({ attribute: false }) workboard: { captured: boolean; busy: boolean } | null = null;
  @property({ attribute: false }) onAction: (action: SessionMenuAction) => void = () => {};
  @property({ attribute: false }) onClose: () => void = () => {};
  @state() private compactView: CompactSessionMenuView = "root";
  private compactViewStack: Array<{ view: CompactSessionMenuView; triggerValue: string }> = [];
  @state() private iconPickerMode: "grid" | "custom" = "grid";
  @state() private customIconValue = "";
  readonly menuLifecycle = new DropdownMenuController(this, {
    getTrigger: () => this.trigger,
    onClose: () => this.onClose(),
    onKeydown: (event) => this.handleMenuKeydown(event),
  });

  override connectedCallback() {
    super.connectedCallback();
    // Sidebar-hosted menus live inside the nav stacking context (z-index 10),
    // which paints below the sidebar resizer divider (z-index 20); promoting
    // the menu to the popover top layer keeps app chrome from bleeding
    // through it (same pattern as openclaw-native-link-menu).
    promoteToPopoverTopLayer(this);
  }

  private runAction(action: SessionMenuAction) {
    if (this.actionDisabledReasons[action.kind]) {
      return;
    }
    this.onClose();
    this.onAction(action);
  }

  private actionDisabled(kind: SessionMenuActionKind, extra = false): boolean {
    return this.disabled || extra || Boolean(this.actionDisabledReasons[kind]);
  }

  private actionTitle(kind: SessionMenuActionKind): string | typeof nothing {
    return this.actionDisabledReasons[kind] ?? nothing;
  }

  private returnToPreviousCompactView() {
    const previous = this.compactViewStack.pop();
    const triggerValue = previous?.triggerValue;
    this.compactView = previous?.view ?? "root";
    void this.updateComplete.then(() => {
      const selector = triggerValue
        ? `wa-dropdown-item[value="${triggerValue}"]:not([disabled])`
        : "wa-dropdown-item:not([disabled])";
      this.querySelector<HTMLElement>(selector)?.focus();
    });
  }

  private readonly handleSelect = (event: CustomEvent<{ item: { value?: string } }>) => {
    event.preventDefault();
    const value = event.detail.item.value;
    if (!value) {
      return;
    }
    const compactView = compactSessionMenuViewForValue(value);
    if (compactView) {
      if (compactView === "root") {
        this.returnToPreviousCompactView();
        return;
      }
      this.compactViewStack.push({ view: this.compactView, triggerValue: value });
      this.compactView = compactView;
      if (compactView === "icon") {
        this.iconPickerMode = "grid";
        this.customIconValue = "";
      }
      void this.updateComplete.then(() => {
        this.querySelector<HTMLElement>("wa-dropdown-item:not([disabled])")?.focus();
      });
      return;
    }
    const simpleAction = simpleSessionMenuAction(value);
    if (simpleAction) {
      this.runAction(simpleAction);
      return;
    }
    if (value === "open-pr" && this.work?.pullRequestUrl) {
      this.runAction({ kind: "open-pr", url: this.work.pullRequestUrl });
      return;
    }
    if (value.startsWith("open-in:") && this.work?.worktreePath) {
      const editor = value.slice("open-in:".length) as EditorId;
      if (EDITOR_IDS.includes(editor)) {
        this.runAction({ kind: "open-in", editor, path: this.work.worktreePath });
      }
      return;
    }
    if (value.startsWith("move-to-group:")) {
      const encodedCategory = value.slice("move-to-group:".length);
      this.runAction({
        kind: "move-to-group",
        category: encodedCategory ? decodeURIComponent(encodedCategory) : null,
      });
      return;
    }
    const pinScope = sessionPinScopeFromMenuValue(value);
    if (pinScope !== undefined) {
      this.runAction({ kind: "set-pin-scope", scope: pinScope });
      return;
    }
    if (value.startsWith("set-icon:")) {
      const encodedIcon = value.slice("set-icon:".length);
      this.runAction({
        kind: "set-icon",
        icon: encodedIcon ? decodeURIComponent(encodedIcon) : null,
      });
      return;
    }
    const owner = sessionOwnerAssignmentFromMenuValue(value);
    if (owner) {
      this.runAction({ kind: "assign-owner", owner });
    }
  };

  private readonly handleAfterHide = (event: Event) => {
    // A keyed replacement can finish hiding after its successor opens.
    if (event.currentTarget instanceof Node && event.currentTarget.isConnected) {
      this.onClose();
    }
  };

  private renderWorkItems() {
    const work = this.work;
    if (!work) {
      return nothing;
    }
    const pullRequestUrl = work.pullRequestUrl;
    const worktreePath = work.worktreePath;
    // Hold the row while the path resolves so the menu does not shift under the
    // pointer, then drop it once we know the checkout is unreachable from this
    // browser: a disabled row would only advertise a handoff that cannot run.
    const showEditorEntry = work.loading || Boolean(worktreePath);
    return html`
      <wa-dropdown-item
        class="session-menu__item"
        value="open-pr"
        data-new-tab-action
        data-shortcut="g"
        aria-keyshortcuts="G"
        ?disabled=${this.disabled || !pullRequestUrl}
      >
        <span slot="icon" class="session-menu__icon" aria-hidden="true"
          >${icons.gitPullRequest}</span
        >
        <span class="session-menu__text">${t("sessionsView.openPullRequest")}</span>
        ${menuShortcutHint("g")}
      </wa-dropdown-item>
      ${showEditorEntry ? this.renderEditorEntry(worktreePath) : nothing}
      <div class="session-menu__separator" role="separator"></div>
    `;
  }

  private renderEditorEntry(worktreePath: string | null) {
    if (this.compact) {
      return renderCompactSessionMenuNavigationItem({
        view: "open-in",
        label: t("sessionsView.openInEditorMenu"),
        icon: icons.externalLink,
        disabled: this.disabled || !worktreePath,
      });
    }
    return html`<wa-dropdown-item
      class="session-menu__item"
      ?disabled=${this.disabled || !worktreePath}
    >
      <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.externalLink}</span>
      <span class="session-menu__text">${t("sessionsView.openInEditorMenu")}</span>
      ${worktreePath ? this.renderEditorSubmenu() : nothing}
    </wa-dropdown-item>`;
  }

  private renderEditorSubmenu(inline = false) {
    return renderSessionEditorOptions({ inline, disabled: this.disabled });
  }

  private renderGroupSubmenu(inline = false) {
    return renderSessionGroupOptions({
      inline,
      category: this.session.category,
      categoryClearReturnsToGroups: this.session.categoryClearReturnsToGroups,
      groups: this.groups,
      actionDisabled: (kind) => this.actionDisabled(kind),
      actionTitle: (kind) => this.actionTitle(kind),
    });
  }

  private renderMoreActions(rootPlacementActions: boolean) {
    const session = this.session;
    const ownerOptions = compactSessionOwnerOptions(this.ownerOptions, this.selfOwner);
    return renderSessionMenuMoreActions({
      groupPinAction: rootPlacementActions
        ? groupSessionPinAction({
            category: session.category,
            categoryPinAvailable: session.categoryPinAvailable,
            scope: session.pinScope,
          })
        : null,
      pinDisabled: this.actionDisabled("set-pin-scope", session.archived),
      pinDisabledReason: this.actionDisabledReasons["set-pin-scope"],
      ownerAvailable: ownerOptions.length > 0,
      ownerDisabled: this.actionDisabled("assign-owner"),
      ownerDisabledReason: this.actionDisabledReasons["assign-owner"],
      iconDisabled: this.actionDisabled("set-icon"),
      iconDisabledReason: this.actionDisabledReasons["set-icon"],
      forkDisabled: this.actionDisabled("fork", this.forkDisabled),
      forkDisabledReason: this.actionDisabledReasons.fork,
      forkLabel: t(
        this.forkFromLastCompleted
          ? "sessionsView.forkFromLastCompleted"
          : "sessionsView.forkSession",
      ),
      sessionIdAvailable: Boolean(session.sessionId),
      workboard: this.workboard,
      menuDisabled: this.disabled,
    });
  }

  private renderIconSubmenu(inline = false) {
    return renderSessionIconPicker({
      inline,
      mode: this.iconPickerMode,
      currentIcon: this.session.icon,
      customIconValue: this.customIconValue,
      disabled: this.actionDisabled("set-icon"),
      disabledReason: this.actionDisabledReasons["set-icon"],
      onSelect: this.selectIcon,
      onShowCustom: this.showCustomIconEntry,
      onBack: this.showIconGrid,
      onInput: this.updateCustomIconValue,
      onApply: this.applyCustomIcon,
      onRemove: this.removeIcon,
      onGridKeydown: this.handleIconGridKeydown,
    });
  }

  private readonly selectIcon = (event: MouseEvent, icon: string) => {
    event.stopPropagation();
    this.runAction({ kind: "set-icon", icon });
  };

  private readonly showCustomIconEntry = (event: MouseEvent) => {
    event.stopPropagation();
    this.iconPickerMode = "custom";
    this.customIconValue = "";
    void this.updateComplete.then(() => {
      this.querySelector<HTMLInputElement>(".session-menu__icon-custom-input")?.focus();
    });
  };

  private readonly showIconGrid = (event?: Event) => {
    event?.stopPropagation();
    this.iconPickerMode = "grid";
    this.customIconValue = "";
    void this.updateComplete.then(() => {
      this.querySelector<HTMLButtonElement>(".session-menu__icon-choice--custom")?.focus();
    });
  };

  private readonly updateCustomIconValue = (event: InputEvent) => {
    if (event.currentTarget instanceof HTMLInputElement) {
      this.customIconValue = event.currentTarget.value;
    }
  };

  private readonly applyCustomIcon = (event?: Event) => {
    event?.stopPropagation();
    const icon = normalizeSessionIconValue(this.customIconValue);
    if (icon) {
      this.runAction({ kind: "set-icon", icon });
    }
  };

  private handleMenuKeydown(event: KeyboardEvent) {
    const input = event
      .composedPath()
      .find(
        (target): target is HTMLInputElement =>
          target instanceof HTMLInputElement &&
          target.classList.contains("session-menu__icon-custom-input"),
      );
    if (!input) {
      if (event.key === "Escape" && this.compactView !== "root") {
        event.preventDefault();
        event.stopPropagation();
        this.returnToPreviousCompactView();
        return;
      }
      activateMenuShortcut(this, event);
      return;
    }
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      this.showIconGrid();
    } else if (event.key === "Enter") {
      const icon = normalizeSessionIconValue(input.value);
      if (icon) {
        event.preventDefault();
        this.customIconValue = input.value;
        this.applyCustomIcon();
      }
    }
  }

  private readonly removeIcon = (event: MouseEvent) => {
    event.stopPropagation();
    this.runAction({ kind: "set-icon", icon: null });
  };

  private readonly handleIconGridKeydown = (event: KeyboardEvent) => {
    const choice = event.target;
    if (!(choice instanceof HTMLButtonElement)) {
      return;
    }
    const offsets: Partial<Record<string, number>> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -SESSION_ICON_GRID_COLUMNS,
      ArrowDown: SESSION_ICON_GRID_COLUMNS,
    };
    const offset = offsets[event.key];
    if (offset === undefined) {
      return;
    }
    const grid = event.currentTarget;
    if (!(grid instanceof HTMLElement)) {
      return;
    }
    const choices = Array.from(
      grid.querySelectorAll<HTMLButtonElement>(".session-menu__icon-choice:not(:disabled)"),
    );
    const index = choices.indexOf(choice);
    if (index < 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const nextIndex = (index + offset + choices.length) % choices.length;
    choices.forEach((button, buttonIndex) => {
      button.tabIndex = buttonIndex === nextIndex ? 0 : -1;
    });
    choices[nextIndex]?.focus();
  };

  override render() {
    const menuWidth = 240;
    const menuMaxHeight = 460;
    const clampedX = Math.max(8, Math.min(this.anchor.x, window.innerWidth - menuWidth - 8));
    const clampedY = Math.max(8, Math.min(this.anchor.y, window.innerHeight - menuMaxHeight - 8));
    const session = this.session;
    const batch = this.selectionCount > 1;
    // Pinning and grouping place root rows; child placement is owned by lineage.
    const rootPlacementActions = session.isChild !== true;
    const globalPinAction = globalSessionPinAction(session.pinScope);
    const count = String(this.selectionCount);
    const menuLabel = batch
      ? t("chat.sidebar.sessionMenuMany", { count })
      : t("chat.sidebar.sessionMenu", { session: session.label });
    return keyed(
      this.anchor,
      html`<wa-dropdown
        class=${`session-menu${this.compact ? " session-menu--compact" : ""}`}
        .open=${true}
        placement="bottom-start"
        .distance=${0}
        aria-label=${menuLabel}
        @wa-select=${this.handleSelect}
        @wa-after-hide=${this.handleAfterHide}
      >
        <button
          slot="trigger"
          type="button"
          tabindex="-1"
          aria-hidden="true"
          aria-label=${menuLabel}
          style="position: fixed; left: ${clampedX}px; top: ${clampedY}px; width: 1px; height: 1px; opacity: 0; pointer-events: none;"
        ></button>
        ${this.compactView !== "root"
          ? renderCompactSessionMenuView({
              view: this.compactView,
              ownerOptions: compactSessionOwnerOptions(this.ownerOptions, this.selfOwner),
              currentOwnerId: this.currentOwnerId,
              assignOwnerDisabled: this.actionDisabled("assign-owner"),
              assignOwnerDisabledReason: this.actionDisabledReasons["assign-owner"],
              renderOpenIn: () => this.renderEditorSubmenu(true),
              renderIcon: () => this.renderIconSubmenu(true),
              renderGroup: () => this.renderGroupSubmenu(true),
              renderMore: () => this.renderMoreActions(rootPlacementActions),
            })
          : html`
              ${!batch && this.lastActive
                ? html`<div class="session-menu__info">
                    ${t("sessionsView.lastActive", { time: this.lastActive })}
                  </div>`
                : nothing}
              ${batch ? nothing : this.renderWorkItems()}
              ${batch || !rootPlacementActions
                ? nothing
                : html`
                    <wa-dropdown-item
                      class="session-menu__item"
                      value=${`pin-scope:${globalPinAction.scope ?? "none"}`}
                      data-shortcut="p"
                      aria-keyshortcuts="P"
                      ?disabled=${this.actionDisabled("set-pin-scope", session.archived)}
                      title=${this.actionTitle("set-pin-scope")}
                    >
                      <span slot="icon" class="session-menu__icon" aria-hidden="true"
                        >${session.pinScope === "global" ? icons.pinOff : icons.pin}</span
                      >
                      <span class="session-menu__text">${globalPinAction.label}</span>
                      ${menuShortcutHint("p")}
                    </wa-dropdown-item>
                  `}
              <wa-dropdown-item
                class="session-menu__item"
                value="toggle-unread"
                data-shortcut="u"
                aria-keyshortcuts="U"
                ?disabled=${this.actionDisabled("toggle-unread")}
                title=${this.actionTitle("toggle-unread")}
              >
                <span slot="icon" class="session-menu__icon" aria-hidden="true"
                  >${session.unread ? icons.eye : icons.circle}</span
                >
                <span class="session-menu__text"
                  >${batch
                    ? session.unread
                      ? t("sessionsView.markReadCount", { count })
                      : t("sessionsView.markUnreadCount", { count })
                    : session.unread
                      ? t("sessionsView.markRead")
                      : t("sessionsView.markUnread")}</span
                >
                ${menuShortcutHint("u")}
              </wa-dropdown-item>
              ${batch
                ? nothing
                : html`
                    <wa-dropdown-item
                      class="session-menu__item"
                      value="rename"
                      data-shortcut="r"
                      aria-keyshortcuts="R"
                      ?disabled=${this.actionDisabled("rename")}
                      title=${this.actionTitle("rename")}
                    >
                      <span slot="icon" class="session-menu__icon" aria-hidden="true"
                        >${icons.edit}</span
                      >
                      <span class="session-menu__text">${t("sessionsView.renameSessionMenu")}</span>
                      ${menuShortcutHint("r")}
                    </wa-dropdown-item>
                  `}
              ${rootPlacementActions
                ? this.compact
                  ? renderCompactSessionMenuNavigationItem({
                      view: "group",
                      label: batch
                        ? t("sessionsView.moveToGroupMenuCount", { count })
                        : t("sessionsView.moveToGroupMenu"),
                      icon: icons.folder,
                      disabled: this.actionDisabled("move-to-group"),
                      title: this.actionDisabledReasons["move-to-group"],
                    })
                  : html`<wa-dropdown-item
                      class="session-menu__item"
                      ?disabled=${this.actionDisabled("move-to-group")}
                      title=${this.actionTitle("move-to-group")}
                    >
                      <span slot="icon" class="session-menu__icon" aria-hidden="true"
                        >${icons.folder}</span
                      >
                      <span class="session-menu__text"
                        >${batch
                          ? t("sessionsView.moveToGroupMenuCount", { count })
                          : t("sessionsView.moveToGroupMenu")}</span
                      >
                      ${this.renderGroupSubmenu()}
                    </wa-dropdown-item>`
                : nothing}
              ${batch
                ? nothing
                : renderCompactSessionMenuNavigationItem({
                    view: "more",
                    label: t("sessionsView.moreActions"),
                    icon: icons.moreHorizontal,
                  })}
              <div class="session-menu__separator" role="separator"></div>
              ${!batch && this.cloudWorkerStopAllowed
                ? html`
                    <wa-dropdown-item
                      class="session-menu__item session-menu__item--destructive"
                      value="stop-cloud-worker"
                      variant="danger"
                      ?disabled=${this.actionDisabled("stop-cloud-worker")}
                      title=${this.actionTitle("stop-cloud-worker")}
                    >
                      <span slot="icon" class="session-menu__icon" aria-hidden="true"
                        >${icons.stop}</span
                      >
                      <span class="session-menu__text">${t("sessionsView.stopCloudWorker")}</span>
                    </wa-dropdown-item>
                  `
                : nothing}
              <wa-dropdown-item
                class="session-menu__item"
                value="toggle-archived"
                data-shortcut="a"
                aria-keyshortcuts="A"
                ?disabled=${this.actionDisabled(
                  "toggle-archived",
                  !batch && !session.archived && !this.archiveAllowed,
                )}
                title=${this.actionTitle("toggle-archived")}
              >
                <span slot="icon" class="session-menu__icon" aria-hidden="true"
                  >${session.archived ? icons.archiveRestore : icons.archive}</span
                >
                <span class="session-menu__text"
                  >${batch
                    ? session.archived
                      ? t("sessionsView.restoreSessionCount", { count })
                      : t("sessionsView.archiveSessionCount", { count })
                    : session.archived
                      ? t("sessionsView.restoreSession")
                      : t("sessionsView.archiveSession")}</span
                >
                ${menuShortcutHint("a")}
              </wa-dropdown-item>
              <wa-dropdown-item
                class="session-menu__item session-menu__item--destructive"
                value="delete"
                variant="danger"
                data-shortcut="d"
                aria-keyshortcuts="D"
                ?disabled=${this.actionDisabled("delete", !this.deleteAllowed)}
                title=${this.actionTitle("delete")}
              >
                <span slot="icon" class="session-menu__icon" aria-hidden="true"
                  >${icons.trash}</span
                >
                <span class="session-menu__text"
                  >${batch
                    ? t("sessionsView.deleteSessionCount", { count })
                    : t("sessionsView.deleteSessionMenu")}</span
                >
                ${menuShortcutHint("d")}
              </wa-dropdown-item>
            `}
      </wa-dropdown>`,
    );
  }
}

if (!customElements.get("openclaw-session-menu")) {
  customElements.define("openclaw-session-menu", SessionMenu);
}
