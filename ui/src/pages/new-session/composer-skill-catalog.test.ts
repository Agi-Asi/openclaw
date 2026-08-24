import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { rememberChatMetadata } from "../../lib/chat/chat-metadata-store.ts";
import { invalidateSlashCommandCatalog } from "../../lib/chat/slash-command-catalog-cache.ts";
import { NewSessionComposerTextareaController } from "./composer.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function skillCatalog(name: string) {
  return {
    commands: [
      {
        name,
        textAliases: [`/${name}`],
        description: `${name} skill`,
        source: "skill" as const,
        scope: "text" as const,
        acceptsArgs: false,
        skillModelVisible: true,
      },
    ],
  };
}

function skillNames(controller: NewSessionComposerTextareaController) {
  return controller
    .getCommandCatalog()
    .filter((command) => command.source === "skill")
    .map((command) => command.name);
}

function mockClient(request: ReturnType<typeof vi.fn>) {
  return { request } as unknown as GatewayBrowserClient;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("new-session command catalog ownership", () => {
  it("uses the selected agent's shared metadata catalog without another request", async () => {
    const request = vi.fn().mockRejectedValue(new Error("commands.list unavailable"));
    const client = mockClient(request);
    rememberChatMetadata(client, "agent-a", skillCatalog("metadata_skill"));
    const controller = new NewSessionComposerTextareaController();

    await controller.refreshCommandCatalog(client, "agent-a", 1);

    expect(request).not.toHaveBeenCalled();
    expect(skillNames(controller)).toEqual(["metadata_skill"]);
  });

  it("reuses a fresh owner catalog and revalidates it after the cache window", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const request = vi
      .fn()
      .mockResolvedValueOnce(skillCatalog("first"))
      .mockResolvedValueOnce(skillCatalog("refreshed"));
    const client = mockClient(request);
    const controller = new NewSessionComposerTextareaController();

    await controller.refreshCommandCatalog(client, "agent-a", 1);
    await controller.refreshCommandCatalog(client, "agent-a", 1);
    expect(request).toHaveBeenCalledOnce();
    expect(skillNames(controller)).toEqual(["first"]);

    now = Number.MAX_SAFE_INTEGER;
    await controller.refreshCommandCatalog(client, "agent-a", 1);
    expect(request).toHaveBeenCalledTimes(2);
    expect(skillNames(controller)).toEqual(["refreshed"]);
  });

  it("clears a warm catalog as soon as the selected agent changes", async () => {
    const request = vi.fn().mockResolvedValue(skillCatalog("skill_a"));
    const client = mockClient(request);
    const controller = new NewSessionComposerTextareaController();

    await controller.refreshCommandCatalog(client, "agent-a", 1);
    expect(skillNames(controller)).toEqual(["skill_a"]);

    controller.syncCommandOwner(client, "agent-b", 1);
    expect(skillNames(controller)).toEqual([]);
  });

  it("reuses an in-flight catalog after returning to the same owner", async () => {
    const firstA = deferred<ReturnType<typeof skillCatalog>>();
    const agentB = deferred<ReturnType<typeof skillCatalog>>();
    const request = vi
      .fn()
      .mockImplementationOnce(() => firstA.promise)
      .mockImplementationOnce(() => agentB.promise);
    const client = mockClient(request);
    const controller = new NewSessionComposerTextareaController();

    const firstRequest = controller.refreshCommandCatalog(client, "agent-a", 1);
    const secondRequest = controller.refreshCommandCatalog(client, "agent-b", 1);
    const thirdRequest = controller.refreshCommandCatalog(client, "agent-a", 1);
    firstA.resolve(skillCatalog("skill_a"));
    await thirdRequest;
    agentB.resolve(skillCatalog("skill_b"));
    await Promise.all([firstRequest, secondRequest]);

    expect(request).toHaveBeenCalledTimes(2);
    expect(skillNames(controller)).toEqual(["skill_a"]);
  });

  it("ignores a delayed catalog from the previous connection epoch", async () => {
    const oldConnection = deferred<ReturnType<typeof skillCatalog>>();
    const newConnection = deferred<ReturnType<typeof skillCatalog>>();
    const request = vi
      .fn()
      .mockImplementationOnce(() => oldConnection.promise)
      .mockImplementationOnce(() => newConnection.promise);
    const client = mockClient(request);
    const controller = new NewSessionComposerTextareaController();

    const oldRequest = controller.refreshCommandCatalog(client, "agent-a", 1);
    invalidateSlashCommandCatalog(client);
    const freshRequest = controller.refreshCommandCatalog(client, "agent-a", 2);
    newConnection.resolve(skillCatalog("fresh"));
    await freshRequest;
    oldConnection.resolve(skillCatalog("stale"));
    await oldRequest;

    expect(skillNames(controller)).toEqual(["fresh"]);
  });

  it("retries after a failed catalog request", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("catalog unavailable"))
      .mockResolvedValueOnce(skillCatalog("recovered"));
    const client = mockClient(request);
    const controller = new NewSessionComposerTextareaController();

    await controller.refreshCommandCatalog(client, "agent-a", 1);
    expect(skillNames(controller)).toEqual([]);
    await controller.refreshCommandCatalog(client, "agent-a", 1);

    expect(request).toHaveBeenCalledTimes(2);
    expect(skillNames(controller)).toEqual(["recovered"]);
  });

  it("coalesces concurrent requests for the same owner", async () => {
    const pending = deferred<ReturnType<typeof skillCatalog>>();
    const request = vi
      .fn()
      .mockImplementationOnce(() => pending.promise)
      .mockRejectedValueOnce(new Error("duplicate request failed"));
    const client = mockClient(request);
    const controller = new NewSessionComposerTextareaController();

    const firstRequest = controller.refreshCommandCatalog(client, "agent-a", 1);
    const secondRequest = controller.refreshCommandCatalog(client, "agent-a", 1);
    pending.resolve(skillCatalog("available"));
    await Promise.all([firstRequest, secondRequest]);

    expect(request).toHaveBeenCalledOnce();
    expect(skillNames(controller)).toEqual(["available"]);
  });

  it.each(["config.changed", "skills.changed"])(
    "invalidates a warm catalog after %s",
    async (event) => {
      const request = vi
        .fn()
        .mockResolvedValueOnce(skillCatalog("before_change"))
        .mockResolvedValueOnce(skillCatalog("after_change"));
      const client = mockClient(request);
      const controller = new NewSessionComposerTextareaController();
      const requestUpdate = vi.fn();

      await controller.refreshCommandCatalog(client, "agent-a", 1);
      invalidateSlashCommandCatalog(client);
      controller.handleGatewayEvent(event, requestUpdate);
      expect(skillNames(controller)).toEqual([]);

      await controller.refreshCommandCatalog(client, "agent-a", 1);
      expect(request).toHaveBeenNthCalledWith(2, "commands.list", {
        agentId: "agent-a",
        includeArgs: true,
        scope: "text",
      });
      expect(skillNames(controller)).toEqual(["after_change"]);
    },
  );

  it("does not retain a catalog request invalidated by a live skill change", async () => {
    const stale = deferred<ReturnType<typeof skillCatalog>>();
    const request = vi
      .fn()
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValueOnce(skillCatalog("fresh"));
    const client = mockClient(request);
    const controller = new NewSessionComposerTextareaController();

    const staleRefresh = controller.refreshCommandCatalog(client, "agent-a", 1);
    invalidateSlashCommandCatalog(client);
    controller.handleGatewayEvent("skills.changed", () => undefined);
    await controller.refreshCommandCatalog(client, "agent-a", 1);
    stale.resolve(skillCatalog("stale"));
    await staleRefresh;
    await controller.refreshCommandCatalog(client, "agent-a", 1);

    expect(request).toHaveBeenCalledTimes(2);
    expect(skillNames(controller)).toEqual(["fresh"]);
  });

  it("invalidates cached catalogs for every agent after a gateway-wide change", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(skillCatalog("agent_a_before"))
      .mockResolvedValueOnce(skillCatalog("agent_b_before"))
      .mockResolvedValueOnce(skillCatalog("agent_a_after"));
    const client = mockClient(request);
    const controller = new NewSessionComposerTextareaController();

    await controller.refreshCommandCatalog(client, "agent-a", 1);
    await controller.refreshCommandCatalog(client, "agent-b", 1);
    invalidateSlashCommandCatalog(client);
    controller.handleGatewayEvent("skills.changed", () => undefined);
    await controller.refreshCommandCatalog(client, "agent-a", 1);

    expect(request).toHaveBeenCalledTimes(3);
    expect(skillNames(controller)).toEqual(["agent_a_after"]);
  });

  it("replaces metadata-backed skills after app-level invalidation", async () => {
    const request = vi.fn().mockResolvedValueOnce(skillCatalog("fresh_skill"));
    const client = mockClient(request);
    rememberChatMetadata(client, "agent-a", skillCatalog("stale_metadata_skill"));
    const controller = new NewSessionComposerTextareaController();

    await controller.refreshCommandCatalog(client, "agent-a", 1);
    expect(skillNames(controller)).toEqual(["stale_metadata_skill"]);
    invalidateSlashCommandCatalog(client);
    controller.handleGatewayEvent("skills.changed", () => undefined);
    await controller.refreshCommandCatalog(client, "agent-a", 1);

    expect(request).toHaveBeenCalledOnce();
    expect(skillNames(controller)).toEqual(["fresh_skill"]);
  });

  it("keeps an expired catalog on transient failure and recovers on retry", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const request = vi
      .fn()
      .mockResolvedValueOnce(skillCatalog("available"))
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce(skillCatalog("recovered"));
    const client = mockClient(request);
    const controller = new NewSessionComposerTextareaController();

    await controller.refreshCommandCatalog(client, "agent-a", 1);
    now = Number.MAX_SAFE_INTEGER;
    await controller.refreshCommandCatalog(client, "agent-a", 1);
    expect(skillNames(controller)).toEqual(["available"]);
    await controller.refreshCommandCatalog(client, "agent-a", 1);

    expect(request).toHaveBeenCalledTimes(3);
    expect(skillNames(controller)).toEqual(["recovered"]);
  });
});
