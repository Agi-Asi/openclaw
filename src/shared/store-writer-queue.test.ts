// Verifies queue ownership and reentrancy across separately loaded runtime chunks.
import { AsyncLocalStorage } from "node:async_hooks";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { runQueuedStoreWrite, type StoreWriterQueue } from "./store-writer-queue.js";

it("shares reentrant writer context across duplicate module instances", async () => {
  const first = await importFreshModule<typeof import("./store-writer-queue.js")>(
    import.meta.url,
    "./store-writer-queue.js?scope=store-writer-a",
  );
  const second = await importFreshModule<typeof import("./store-writer-queue.js")>(
    import.meta.url,
    "./store-writer-queue.js?scope=store-writer-b",
  );
  const queues = new Map<string, StoreWriterQueue>();
  const order: string[] = [];

  const result = await first.runQueuedStoreWrite({
    queues,
    storePath: "shared-store",
    label: "outer",
    fn: async () => {
      order.push("outer:start");
      const nested = await second.runQueuedStoreWrite({
        queues,
        storePath: "shared-store",
        label: "inner",
        reentrant: true,
        fn: async () => {
          order.push("inner");
          return "nested-result";
        },
      });
      order.push("outer:end");
      return nested;
    },
  });

  expect(result).toBe("nested-result");
  expect(order).toEqual(["outer:start", "inner", "outer:end"]);
  expect(queues.size).toBe(0);
});

it("restores each queued caller's complete async context", async () => {
  const ownerContext = new AsyncLocalStorage<string>();
  const requestContext = new AsyncLocalStorage<string>();
  const queues = new Map<string, StoreWriterQueue>();
  const firstStarted = createDeferred();
  const releaseFirst = createDeferred();
  const readContext = () => [ownerContext.getStore(), requestContext.getStore()];

  const first = ownerContext.run("first-owner", () =>
    requestContext.run("first-request", () =>
      runQueuedStoreWrite({
        queues,
        storePath: "caller-context-store",
        label: "first caller",
        fn: async () => {
          firstStarted.resolve();
          await releaseFirst.promise;
          return readContext();
        },
      }),
    ),
  );
  await firstStarted.promise;

  const second = ownerContext.run("second-owner", () =>
    requestContext.run("second-request", () =>
      runQueuedStoreWrite({
        queues,
        storePath: "caller-context-store",
        label: "second caller",
        fn: async () => readContext(),
      }),
    ),
  );
  const unscoped = runQueuedStoreWrite({
    queues,
    storePath: "caller-context-store",
    label: "unscoped caller",
    fn: async () => readContext(),
  });

  releaseFirst.resolve();
  await expect(Promise.all([first, second, unscoped])).resolves.toEqual([
    ["first-owner", "first-request"],
    ["second-owner", "second-request"],
    [undefined, undefined],
  ]);
  expect(queues.size).toBe(0);
});
