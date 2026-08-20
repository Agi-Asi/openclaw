import type { GatewaySessionRow } from "../../api/types.ts";
import { resolveSessionWorkSubtitle } from "../session-display.ts";

type SessionHostKind = "gateway" | "node" | "cloud";

export type SessionHost = {
  id: string;
  label: string;
  kind: SessionHostKind;
};

export type SessionHostRow = {
  sessionHost: SessionHost;
};

/** Stable execution-host projection for sidebar grouping and filtering. */
export function resolveSessionHost(
  row: Pick<GatewaySessionRow, "execNode" | "placement">,
): SessionHost {
  const placement = row.placement;
  if (placement && placement.state !== "local") {
    return { id: "cloud", label: "Cloud workers", kind: "cloud" };
  }
  const execNode = row.execNode?.trim();
  if (execNode) {
    return {
      id: `node:${execNode}`,
      label: resolveSessionWorkSubtitle({ execNode }) ?? execNode,
      kind: "node",
    };
  }
  return { id: "gateway", label: "Gateway", kind: "gateway" };
}

export function listSessionHosts(
  rows: readonly SessionHostRow[],
): Array<SessionHost & { count: number }> {
  const hosts = new Map<string, SessionHost & { count: number }>();
  for (const row of rows) {
    const current = hosts.get(row.sessionHost.id);
    if (current) {
      current.count += 1;
    } else {
      hosts.set(row.sessionHost.id, { ...row.sessionHost, count: 1 });
    }
  }
  const order: Record<SessionHostKind, number> = { gateway: 0, node: 1, cloud: 2 };
  return [...hosts.values()].toSorted(
    (a, b) =>
      order[a.kind] - order[b.kind] || a.label.localeCompare(b.label) || a.id.localeCompare(b.id),
  );
}
