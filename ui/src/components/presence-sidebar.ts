import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { activityPersonLocation } from "../app-route-paths.ts";
import type { RouteId } from "../app-routes.ts";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import {
  readPresenceEntries,
  resolveCurrentSelfUser,
  type PresencePayload,
} from "../app/user-profile.ts";
import { t } from "../i18n/index.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import {
  isPresenceViewerIdle,
  presenceViewerLabel,
  projectOnlinePresenceViewers,
  type PresenceViewer,
} from "../lib/presence-users.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import { DockLayoutController } from "./dock-layout-controller.ts";
import { createDockPanelLayout } from "./dock-panel-layout.ts";
import { icons } from "./icons.ts";
import "./presence-sidebar.css";
import "./tooltip.ts";

const presenceSidebarLayout = createDockPanelLayout({
  storageKey: "openclaw.presence.sidebar.v1",
  minHeight: 0,
  minWidth: 220,
  defaultOpen: true,
  defaultDock: "right",
  supportedDocks: ["right"],
  defaultHeight: 0,
  defaultWidth: 240,
});

class PresenceSidebar extends OpenClawLightDomElement {
  @property({ type: Boolean }) suppressed = false;
  @state() private presencePayload: PresencePayload | undefined;

  @consume({ context: applicationContext, subscribe: true })
  protected context?: ApplicationContext<RouteId>;

  private readonly dockLayout = new DockLayoutController(this, {
    layout: presenceSidebarLayout,
    reservationPrefix: "presence",
    isAvailable: () => this.users().length > 0,
  });
  private readonly subscriptions: SubscriptionsController;

  constructor() {
    super();
    this.subscriptions = new SubscriptionsController(this);
    this.subscriptions
      .watch(
        () => this.context?.gateway,
        (gateway, notify) => gateway.subscribe(notify),
        (gateway) => this.synchronizeGateway(gateway),
      )
      .effect(
        () => this.context?.gateway,
        (gateway) =>
          gateway.subscribeEvents((event) => {
            if (event.event !== "presence") {
              return;
            }
            const presence = readPresenceEntries(event.payload);
            this.presencePayload = presence ? { presence } : undefined;
            this.synchronizeAvailability();
            this.requestUpdate();
          }),
      );
  }

  override updated(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("suppressed")) {
      this.dockLayout.setSuppressed(this.suppressed);
      this.synchronizeAvailability();
    }
  }

  private synchronizeGateway(gateway: ApplicationContext<RouteId>["gateway"]): void {
    const presence =
      gateway.snapshot.phase === "connected"
        ? readPresenceEntries(gateway.snapshot.hello?.snapshot)
        : undefined;
    this.presencePayload = presence ? { presence } : undefined;
    this.synchronizeAvailability();
  }

  private users(): readonly PresenceViewer[] {
    const selfUser = resolveCurrentSelfUser({
      snapshotUser: this.context?.gateway.snapshot.selfUser,
      presenceEntries: readPresenceEntries(this.presencePayload),
      presenceInstanceId: this.context?.gateway.snapshot.client?.instanceId,
    });
    return projectOnlinePresenceViewers(
      this.presencePayload,
      selfUser?.id,
      this.context?.gateway.snapshot.client?.instanceId,
    );
  }

  private synchronizeAvailability(): void {
    if (this.suppressed || this.users().length === 0) {
      this.dockLayout.hideWithoutPersisting();
      return;
    }
    this.dockLayout.restoreOpenState();
    this.dockLayout.syncReservation();
  }

  private setOpen(open: boolean): void {
    this.dockLayout.setOpen(open);
  }

  override render() {
    const users = this.users();
    if (this.suppressed || users.length === 0) {
      return nothing;
    }
    if (!this.dockLayout.open) {
      return html`<openclaw-tooltip .content=${t("presence.showRoster")}>
        <button
          type="button"
          class="shell-chrome-controls__button presence-sidebar__toggle"
          aria-label=${t("presence.showRoster")}
          aria-expanded="false"
          @click=${() => this.setOpen(true)}
        >
          ${icons.users}
        </button>
      </openclaw-tooltip>`;
    }
    const label = t("presence.rosterTitle");
    return html`<aside class="presence-sidebar__panel" aria-label=${label}>
      <header class="presence-sidebar__header">
        <span class="presence-sidebar__title">${label} · ${users.length}</span>
        <openclaw-tooltip .content=${t("presence.hideRoster")}>
          <button
            type="button"
            class="shell-chrome-controls__button presence-sidebar__close"
            aria-label=${t("presence.hideRoster")}
            aria-expanded="true"
            @click=${() => this.setOpen(false)}
          >
            ${icons.panelRightClose}
          </button>
        </openclaw-tooltip>
      </header>
      <div class="presence-sidebar__list">
        ${users.map((user) => {
          const { pathname, search, href } = activityPersonLocation(
            user.id,
            this.context?.basePath ?? "",
          );
          return html`<a
            class="sidebar-online__person ${isPresenceViewerIdle(user)
              ? "sidebar-online__person--away"
              : ""}"
            data-online-user-id=${user.id}
            href=${href}
            @click=${(event: MouseEvent) => {
              if (!shouldHandleNavigationClick(event)) {
                return;
              }
              event.preventDefault();
              this.context?.navigate("activity", { pathname, search });
            }}
          >
            <openclaw-viewer-avatar .user=${user} variant="footer"></openclaw-viewer-avatar>
            <span class="sidebar-online__person-name">${presenceViewerLabel(user)}</span>
            <span class="sidebar-online__person-action" aria-hidden="true"
              >${icons.chevronRight}</span
            >
          </a>`;
        })}
      </div>
    </aside>`;
  }
}

if (!customElements.get("openclaw-presence-sidebar")) {
  customElements.define("openclaw-presence-sidebar", PresenceSidebar);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-presence-sidebar": PresenceSidebar;
  }
}
