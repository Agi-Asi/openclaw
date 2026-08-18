// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { SessionCatalog } from "../../../packages/gateway-protocol/src/index.ts";
import { SessionCatalogLiveState } from "./app-sidebar-session-catalog-live.ts";

function catalog(id: string, hostCount: number): SessionCatalog {
  return {
    id,
    label: id,
    capabilities: { continueSession: true, archive: true },
    hosts: Array.from({ length: hostCount }, (_, hostIndex) => ({
      hostId: `${id}-host-${hostIndex}`,
      label: `Host ${hostIndex}`,
      kind: "node",
      connected: true,
      sessions: [
        {
          threadId: `${id}-thread-${hostIndex}`,
          name: `Session ${hostIndex}`,
          status: "idle",
          archived: false,
          canContinue: true,
          canArchive: true,
        },
      ],
    })),
  };
}

describe("SessionCatalogLiveState", () => {
  it("compares a host event only with the catalog and host it can replace", () => {
    const live = new SessionCatalogLiveState();
    const { progressId } = live.beginRequest(1);
    const changed = catalog("changed", 1);
    const unrelated = catalog("unrelated", 100);
    Object.defineProperty(unrelated, "toJSON", {
      value: () => {
        throw new Error("unrelated catalog serialized");
      },
    });

    let result: ReturnType<SessionCatalogLiveState["applyHost"]>;
    expect(() => {
      result = live.applyHost({
        payload: {
          progressId,
          agentId: "main",
          catalog: { ...changed, hosts: [changed.hosts[0]!] },
        },
        agentId: "main",
        catalogs: [changed, unrelated],
        pageDepths: new Map(),
      });
    }).not.toThrow();
    expect(result!).toBeNull();
  });

  it.each([
    {
      metadata: "capabilities",
      update: (current: SessionCatalog): SessionCatalog => ({
        ...current,
        capabilities: {
          ...current.capabilities,
          createSession: { model: "openai/gpt-5.6-luna" },
        },
      }),
    },
    {
      metadata: "catalog error",
      update: (current: SessionCatalog): SessionCatalog => ({
        ...current,
        error: { code: "unavailable", message: "Catalog temporarily unavailable" },
      }),
    },
  ])("applies $metadata without marking a material change", ({ update }) => {
    const live = new SessionCatalogLiveState();
    const { progressId } = live.beginRequest(1);
    const current = catalog("changed", 1);

    const result = live.applyHost({
      payload: {
        progressId,
        agentId: "main",
        catalog: { ...update(current), hosts: [current.hosts[0]!] },
      },
      agentId: "main",
      catalogs: [current],
      pageDepths: new Map(),
    });

    expect(result?.catalogs[0]).toEqual(update(current));
    expect(result?.materialChange).toBe(false);
    expect(live.sawChange).toBe(false);
  });
});

describe("SessionCatalogLiveState presence refreshes", () => {
  it("ignores mode-less and explicit non-node presence churn", () => {
    const live = new SessionCatalogLiveState();

    expect(live.observePresence({ presence: [{ deviceId: "legacy-client" }] })).toBe(false);
    expect(
      live.observePresence({ presence: [{ deviceId: "operator-client", mode: "operator" }] }),
    ).toBe(false);
    expect(
      live.observePresence({ presence: [{ deviceId: "browser-client", mode: "webchat" }] }),
    ).toBe(false);
  });

  it("treats explicit mode as authoritative over roles", () => {
    const live = new SessionCatalogLiveState();

    expect(
      live.observePresence({
        presence: [{ deviceId: "browser-node", mode: "webchat", roles: ["node"] }],
      }),
    ).toBe(false);
    expect(
      live.observePresence({
        presence: [{ deviceId: "operator-node", mode: "operator", roles: ["node"] }],
      }),
    ).toBe(false);
    expect(
      live.observePresence({
        presence: [{ deviceId: "node-operator", mode: "node", roles: ["operator"] }],
      }),
    ).toBe(true);
  });

  it("invalidates when explicit node presence changes", () => {
    const live = new SessionCatalogLiveState();

    expect(live.observePresence({ presence: [{ deviceId: "devbox", mode: "node" }] })).toBe(true);
    expect(live.observePresence({ presence: [{ deviceId: "devbox", mode: "node" }] })).toBe(false);
    expect(
      live.observePresence({
        presence: [{ deviceId: "devbox", mode: "node", reason: "disconnect" }],
      }),
    ).toBe(true);
  });

  it("accepts a mode-less presence entry with an authenticated node role", () => {
    const live = new SessionCatalogLiveState();

    expect(live.observePresence({ presence: [{ deviceId: "legacy-node", roles: ["node"] }] })).toBe(
      true,
    );
  });
});
