// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { listSessionHosts, resolveSessionHost, type SessionHostRow } from "./session-host.ts";

const timing = {
  createdAtMs: 1,
  generation: 1,
  stateChangedAtMs: 1,
  updatedAtMs: 1,
};

describe("resolveSessionHost", () => {
  it("projects Gateway and node execution hosts without exposing opaque node ids", () => {
    expect(resolveSessionHost({})).toEqual({
      id: "gateway",
      kind: "gateway",
      label: "Gateway",
    });
    expect(resolveSessionHost({ placement: { state: "local", ...timing } })).toEqual({
      id: "gateway",
      kind: "gateway",
      label: "Gateway",
    });
    expect(resolveSessionHost({ execNode: "Mac Studio" })).toEqual({
      id: "node:Mac Studio",
      kind: "node",
      label: "Mac Studio",
    });
    expect(resolveSessionHost({ execNode: "11c38726acc6fac280357576c87acc6fac280357" })).toEqual({
      id: "node:11c38726acc6fac280357576c87acc6fac280357",
      kind: "node",
      label: "…0357",
    });
  });

  it.each(["requested", "active", "reclaimed", "failed"] as const)(
    "projects %s placement under the cloud host",
    (state) => {
      expect(
        resolveSessionHost({
          placement: { state, ...timing } as GatewaySessionRow["placement"],
        }),
      ).toEqual({ id: "cloud", kind: "cloud", label: "Cloud workers" });
    },
  );
});

describe("listSessionHosts", () => {
  it("counts hosts and orders Gateway, nodes, then cloud workers", () => {
    const rows: SessionHostRow[] = [
      { sessionHost: { id: "cloud", kind: "cloud", label: "Cloud workers" } },
      { sessionHost: { id: "node:zeta", kind: "node", label: "Zeta" } },
      { sessionHost: { id: "gateway", kind: "gateway", label: "Gateway" } },
      { sessionHost: { id: "node:alpha", kind: "node", label: "Alpha" } },
      { sessionHost: { id: "node:alpha", kind: "node", label: "Alpha" } },
    ];

    expect(listSessionHosts(rows)).toEqual([
      { count: 1, id: "gateway", kind: "gateway", label: "Gateway" },
      { count: 2, id: "node:alpha", kind: "node", label: "Alpha" },
      { count: 1, id: "node:zeta", kind: "node", label: "Zeta" },
      { count: 1, id: "cloud", kind: "cloud", label: "Cloud workers" },
    ]);
  });
});
