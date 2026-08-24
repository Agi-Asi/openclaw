import { isRecord } from "@openclaw/normalization-core";
import type { SidebarLayout, SidebarPanel, SidebarSlotId } from "./sidebar-layout-types.ts";

const DEFAULT_WIDTH = 480;
const DEFAULT_HEIGHT = 360;
const MIN_WIDTH = 260;
const MIN_HEIGHT = 220;
const MAX_WIDTH = 1_200;
const MAX_HEIGHT = 800;

function isSlotId(value: unknown): value is SidebarSlotId {
  return (
    value === "browser" ||
    value === "chat" ||
    value === "companion" ||
    value === "desktop" ||
    value === "detail" ||
    value === "discussion" ||
    value === "online" ||
    value === "tasks" ||
    value === "terminal" ||
    value === "workspace"
  );
}

function clampWidth(width: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width));
}

function clampHeight(height: number): number {
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, height));
}

function uniqueId(value: unknown, fallback: string, used: Set<string>): string {
  const base = typeof value === "string" && value.trim() ? value.trim() : fallback;
  let id = base;
  let suffix = 2;
  while (used.has(id)) {
    id = `${base}-${suffix++}`;
  }
  used.add(id);
  return id;
}

export function normalizeSidebarLayout(value: unknown): SidebarLayout {
  if (!isRecord(value) || !Array.isArray(value.columns)) {
    return { columns: [], open: false, expanded: false };
  }
  const usedColumnIds = new Set<string>();
  const usedPanelIds = new Set<string>();
  const usedSlots = new Set<SidebarSlotId>();
  const panels: SidebarPanel[] = [];
  let activePanelId = "";
  let columnId = "side-panel-column";
  let hasColumn = false;
  let width = DEFAULT_WIDTH;
  let height = DEFAULT_HEIGHT;
  for (const rawColumn of value.columns) {
    if (
      !isRecord(rawColumn) ||
      (rawColumn.side !== "left" && rawColumn.side !== "right") ||
      !Array.isArray(rawColumn.panels)
    ) {
      continue;
    }
    const normalizedColumnId = uniqueId(rawColumn.id, "column", usedColumnIds);
    if (!hasColumn) {
      columnId = normalizedColumnId;
      hasColumn = true;
    }
    width =
      typeof rawColumn.width === "number" && Number.isFinite(rawColumn.width)
        ? clampWidth(rawColumn.width)
        : width;
    height =
      typeof rawColumn.height === "number" && Number.isFinite(rawColumn.height)
        ? clampHeight(rawColumn.height)
        : height;
    const columnPanels: SidebarPanel[] = [];
    const panelIds = new Map<string, string>();
    for (const rawPanel of rawColumn.panels) {
      if (!isRecord(rawPanel) || !isSlotId(rawPanel.slot) || usedSlots.has(rawPanel.slot)) {
        continue;
      }
      const rawPanelId = typeof rawPanel.id === "string" ? rawPanel.id.trim() : "";
      const panelId = uniqueId(rawPanel.id, rawPanel.slot, usedPanelIds);
      const sourceId = rawPanelId || rawPanel.slot;
      if (!panelIds.has(sourceId)) {
        panelIds.set(sourceId, panelId);
      }
      usedSlots.add(rawPanel.slot);
      columnPanels.push({ id: panelId, slot: rawPanel.slot });
    }
    const requestedActiveId =
      typeof rawColumn.activePanelId === "string" ? rawColumn.activePanelId.trim() : "";
    activePanelId = panelIds.get(requestedActiveId) ?? activePanelId;
    panels.push(...columnPanels);
  }
  const open = typeof value.open === "boolean" ? value.open : panels.length > 0;
  // An open panel keeps one empty column so resize remains available before a
  // tab opens and after the final tab closes.
  const columns =
    panels.length > 0 || hasColumn || open
      ? [
          {
            id: columnId,
            side: "right" as const,
            panels,
            activePanelId:
              panels.find((panel) => panel.id === activePanelId)?.id ?? panels[0]?.id ?? "",
            height,
            width,
          },
        ]
      : [];
  return {
    columns,
    dock: value.dock === "bottom" ? "bottom" : "right",
    open,
    expanded: value.expanded === true,
  };
}
