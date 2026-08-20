import type { ReactiveControllerHost } from "lit";
import type { SidebarSessionsGrouping } from "../lib/sessions/grouping.ts";
import { listSessionHosts } from "../lib/sessions/session-host.ts";
import type { SidebarSessionNavigationState } from "./app-sidebar-session-navigation-logic.ts";
import {
  loadStoredHiddenSessionHostIds,
  storeHiddenSessionHostIds,
  type SidebarRecentSession,
} from "./app-sidebar-session-types.ts";

type SidebarSessionHostFilterHost = ReactiveControllerHost & {
  readonly sessionsGrouping: SidebarSessionsGrouping;
  getSessionNavigationState(): SidebarSessionNavigationState;
  selectedAgentSessionRows(navigationState: SidebarSessionNavigationState): SidebarRecentSession[];
};

/** Owns browser-local execution-host filters without changing canonical session rows. */
export class SidebarSessionHostFilterController {
  hiddenHostIds = loadStoredHiddenSessionHostIds();

  constructor(private readonly host: SidebarSessionHostFilterHost) {}

  get options() {
    return listSessionHosts(
      this.host.selectedAgentSessionRows(this.host.getSessionNavigationState()),
    );
  }

  get active(): boolean {
    return (
      this.host.sessionsGrouping === "host" &&
      this.options.some((host) => this.hiddenHostIds.has(host.id))
    );
  }

  filter(rows: SidebarRecentSession[]): SidebarRecentSession[] {
    return this.host.sessionsGrouping === "host"
      ? rows.filter((row) => !this.hiddenHostIds.has(row.sessionHost.id))
      : rows;
  }

  pinnedByKey(rows: SidebarRecentSession[]) {
    return new Map(
      this.filter(rows)
        .filter((row) => row.pinned)
        .map((row) => [row.key, row]),
    );
  }

  toggle(hostId: string): void {
    const next = new Set(this.hiddenHostIds);
    if (next.has(hostId)) {
      next.delete(hostId);
    } else {
      next.add(hostId);
    }
    this.update(next);
  }

  toggleAll(): void {
    const allVisible = this.options.every((host) => !this.hiddenHostIds.has(host.id));
    this.update(allVisible ? new Set(this.options.map((host) => host.id)) : new Set());
  }

  private update(hostIds: ReadonlySet<string>): void {
    this.hiddenHostIds = new Set(hostIds);
    try {
      storeHiddenSessionHostIds(hostIds);
    } catch {
      // Keep the in-memory preference when storage is unavailable.
    }
    this.host.requestUpdate();
  }
}
