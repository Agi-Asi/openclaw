import { html, type TemplateResult } from "lit";
import { activityPersonLocation } from "../app-route-paths.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import {
  isPresenceViewerIdle,
  presenceViewerLabel,
  type PresenceViewer,
} from "../lib/presence-users.ts";
import { icons } from "./icons.ts";

type OnlinePresenceNavigation = { pathname: string; search: string };

export function renderOnlinePresenceList(params: {
  users: readonly PresenceViewer[];
  basePath: string;
  onNavigate?: (location: OnlinePresenceNavigation) => void;
}): TemplateResult[] {
  return params.users.map((user) => {
    const { pathname, search, href } = activityPersonLocation(user.id, params.basePath);
    return html`<a
      class="sidebar-online__person ${isPresenceViewerIdle(user)
        ? "sidebar-online__person--away"
        : ""}"
      data-online-user-id=${user.id}
      href=${href}
      @click=${(event: MouseEvent) => {
        if (!params.onNavigate || !shouldHandleNavigationClick(event)) {
          return;
        }
        event.preventDefault();
        params.onNavigate({ pathname, search });
      }}
    >
      <openclaw-viewer-avatar .user=${user} variant="footer"></openclaw-viewer-avatar>
      <span class="sidebar-online__person-name">${presenceViewerLabel(user)}</span>
      <span class="sidebar-online__person-action" aria-hidden="true">${icons.chevronRight}</span>
    </a>`;
  });
}
