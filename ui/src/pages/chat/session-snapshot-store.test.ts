/* @vitest-environment jsdom */

import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  appendChatMessageToCache,
  cacheChatSessionSnapshot,
  observeChatCache,
  type ChatMessageCache,
  type ChatSessionSnapshot,
} from "./session-message-cache.ts";
import { CHAT_SNAPSHOT_DB_VERSION } from "./session-snapshot-database.ts";
import {
  CHAT_SNAPSHOT_DB_NAME,
  CHAT_SNAPSHOT_METADATA_STORE_NAME,
  CHAT_SNAPSHOT_STORE_NAME,
} from "./session-snapshot-database.ts";
import { clearStoredChatSnapshots } from "./session-snapshot-invalidation.ts";
import { SessionSnapshotStore, readStoredChatSnapshot } from "./session-snapshot-store.ts";

function snapshot(message: unknown, sessionId = "session-1"): ChatSessionSnapshot {
  return {
    displayedLeafEntryId: "leaf-1",
    messages: [message],
    pagination: { hasMore: true, nextOffset: 1, totalMessages: 2 },
    sessionId,
  };
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    const rejectTransaction = () => reject(transaction.error ?? new Error("transaction failed"));
    transaction.addEventListener("error", rejectTransaction);
    transaction.addEventListener("abort", rejectTransaction);
  });
}

async function putRawRecord(record: unknown): Promise<void> {
  const request = indexedDB.open(CHAT_SNAPSHOT_DB_NAME);
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("database open failed")),
    );
  });
  const transaction = database.transaction(
    [CHAT_SNAPSHOT_STORE_NAME, CHAT_SNAPSHOT_METADATA_STORE_NAME],
    "readwrite",
  );
  const completed = transactionDone(transaction);
  transaction.objectStore(CHAT_SNAPSHOT_STORE_NAME).put(record);
  transaction.objectStore(CHAT_SNAPSHOT_METADATA_STORE_NAME).put({
    savedAt: Date.now(),
    sessionKey: (record as { sessionKey: string }).sessionKey,
    weight: 0,
  });
  await completed;
  database.close();
}

async function putVersionOneRecord(sessionKey: string): Promise<void> {
  const request = indexedDB.open(CHAT_SNAPSHOT_DB_NAME, 1);
  request.addEventListener("upgradeneeded", () => {
    request.result.createObjectStore(CHAT_SNAPSHOT_STORE_NAME, { keyPath: "sessionKey" });
  });
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("database open failed")),
    );
  });
  const transaction = database.transaction(CHAT_SNAPSHOT_STORE_NAME, "readwrite");
  const completed = transactionDone(transaction);
  transaction.objectStore(CHAT_SNAPSHOT_STORE_NAME).put({ sessionKey });
  await completed;
  database.close();
}

async function readRawRecord(sessionKey: string): Promise<{ savedAt: number } | undefined> {
  const request = indexedDB.open(CHAT_SNAPSHOT_DB_NAME);
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("database open failed")),
    );
  });
  const transaction = database.transaction(CHAT_SNAPSHOT_STORE_NAME, "readonly");
  const result = await new Promise<{ savedAt: number } | undefined>((resolve, reject) => {
    const get = transaction.objectStore(CHAT_SNAPSHOT_STORE_NAME).get(sessionKey);
    get.addEventListener("success", () => resolve(get.result));
    get.addEventListener("error", () => reject(get.error ?? new Error("record read failed")));
  });
  await transactionDone(transaction);
  database.close();
  return result;
}

async function readRawMetadata(
  sessionKey: string,
): Promise<{ savedAt: number; weight: number } | undefined> {
  const request = indexedDB.open(CHAT_SNAPSHOT_DB_NAME);
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("database open failed")),
    );
  });
  const transaction = database.transaction(CHAT_SNAPSHOT_METADATA_STORE_NAME, "readonly");
  const result = await new Promise<{ savedAt: number; weight: number } | undefined>(
    (resolve, reject) => {
      const get = transaction.objectStore(CHAT_SNAPSHOT_METADATA_STORE_NAME).get(sessionKey);
      get.addEventListener("success", () => resolve(get.result));
      get.addEventListener("error", () => reject(get.error ?? new Error("metadata read failed")));
    },
  );
  await transactionDone(transaction);
  database.close();
  return result;
}

describe("persistent chat session snapshots", () => {
  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("localStorage", createStorageMock());
  });

  afterEach(async () => {
    await clearStoredChatSnapshots();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shares sanitized snapshots across store owners", async () => {
    const writer = new SessionSnapshotStore();
    writer.write("agent:main:shared", snapshot({ text: "cached", callback: () => true }));
    const savedAt = writer.readSavedAt("agent:main:shared");
    expect(savedAt).not.toBeNull();
    await writer.flush();
    expect(writer.readSavedAt("agent:main:shared")).toBe(savedAt);

    const reader = new SessionSnapshotStore();
    await reader.loadSavedAtIndex();
    expect(await reader.read("agent:main:shared")).toEqual(snapshot({ text: "cached" }));
    expect(reader.readSavedAt("agent:main:shared")).toBe(savedAt);
  });

  it("keeps lightweight eviction metadata alongside each snapshot", async () => {
    const sessionKey = "agent:main:metadata";
    const writer = new SessionSnapshotStore();
    writer.write(sessionKey, snapshot("cached"));
    await writer.flush();

    const record = await readRawRecord(sessionKey);
    const metadata = await readRawMetadata(sessionKey);
    expect(metadata?.savedAt).toBe(record?.savedAt);
    expect(metadata?.weight).toBeGreaterThan(0);

    await writer.delete(sessionKey);
    expect(await readRawMetadata(sessionKey)).toBeUndefined();
  });

  it("round-trips the optional history delta cursor", async () => {
    const sessionKey = "agent:main:cursor";
    const writer = new SessionSnapshotStore();
    const cached = { ...snapshot("cached"), deltaCursor: "cursor-1" };
    writer.write(sessionKey, cached);
    await writer.flush();

    expect(await new SessionSnapshotStore().read(sessionKey)).toEqual(cached);
  });

  it("serves the startup probe straight from storage", async () => {
    const sessionKey = "agent:main:probe";
    const writer = new SessionSnapshotStore();
    writer.write(sessionKey, snapshot("cached"));
    await writer.flush();

    expect(await readStoredChatSnapshot(sessionKey)).toEqual(snapshot("cached"));
    expect(await readStoredChatSnapshot("agent:main:missing")).toBeNull();
  });

  it("keeps one coherent record when two browser contexts write concurrently", async () => {
    // Two tabs are two store instances over one same-origin IndexedDB; the DB
    // serializes their transactions, and the last completed flush owns the key.
    const sessionKey = "agent:main:two-tabs";
    const tabA = new SessionSnapshotStore();
    const tabB = new SessionSnapshotStore();
    tabA.write(sessionKey, snapshot("from-tab-a"));
    tabB.write("agent:main:other", snapshot("unrelated"));
    tabB.write(sessionKey, snapshot("from-tab-b"));
    await Promise.all([tabA.flush(), tabB.flush()]);

    const stored = await readStoredChatSnapshot(sessionKey);
    expect(stored?.messages).toEqual(["from-tab-b"]);
    expect(await readStoredChatSnapshot("agent:main:other")).toEqual(snapshot("unrelated"));

    // A tab that learned an older snapshot later must not resurrect it.
    tabA.write(sessionKey, snapshot("stale-from-tab-a"));
    await tabA.flush();
    await tabB.flush();
    expect((await readStoredChatSnapshot(sessionKey))?.messages).toEqual(["stale-from-tab-a"]);
  });

  it("resets safely across a persisted-database version upgrade with old conversations", async () => {
    // A future schema version (v2 here) must fail closed: the older reader
    // wipes the cache instead of misreading records, and the next write
    // rebuilds a healthy store. Old conversations come back from the network.
    const legacyKey = "agent:main:legacy";
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(CHAT_SNAPSHOT_DB_NAME, CHAT_SNAPSHOT_DB_VERSION + 1);
      request.addEventListener("upgradeneeded", () => {
        request.result.createObjectStore(CHAT_SNAPSHOT_STORE_NAME, { keyPath: "sessionKey" });
      });
      request.addEventListener("success", () => {
        const database = request.result;
        const transaction = database.transaction(CHAT_SNAPSHOT_STORE_NAME, "readwrite");
        transaction.objectStore(CHAT_SNAPSHOT_STORE_NAME).put({
          savedAt: 1,
          sessionId: null,
          sessionKey: legacyKey,
          snapshot: { messages: ["old-conversation"], pagination: { hasMore: false } },
        });
        transaction.addEventListener("complete", () => {
          database.close();
          resolve();
        });
        transaction.addEventListener("error", () =>
          reject(transaction.error ?? new Error("legacy put failed")),
        );
      });
      request.addEventListener("error", () => reject(request.error ?? new Error("open failed")));
    });

    expect(await readStoredChatSnapshot(legacyKey)).toBeNull();

    const rebuilt = new SessionSnapshotStore();
    rebuilt.write(legacyKey, snapshot("fresh"));
    await rebuilt.flush();
    expect((await readStoredChatSnapshot(legacyKey))?.messages).toEqual(["fresh"]);
  });

  it("round-trips a multi-megabyte snapshot through the probe path", async () => {
    const sessionKey = "agent:main:huge";
    const bigBody = "x".repeat(5 * 1024 * 1024);
    const writer = new SessionSnapshotStore();
    writer.write(sessionKey, { ...snapshot(bigBody), deltaCursor: "cursor-huge" });
    await writer.flush();

    const stored = await readStoredChatSnapshot(sessionKey);
    expect(stored?.messages[0]).toBe(bigBody);
    expect(stored?.deltaCursor).toBe("cursor-huge");
  });

  it("does not serve an empty stored transcript to the startup paint gate", async () => {
    const sessionKey = "agent:main:empty";
    const writer = new SessionSnapshotStore();
    writer.write(sessionKey, { ...snapshot("unused"), messages: [] });
    await writer.flush();

    const stored = await readStoredChatSnapshot(sessionKey);
    expect(stored?.messages).toEqual([]);
  });

  it("does not let an append miss replace a richer persisted snapshot", async () => {
    const sessionKey = "agent:main:append-miss";
    const persisted = {
      ...snapshot("unused", "session-rich"),
      deltaCursor: "cursor-rich",
      messages: ["one", "two", "three", "four", "five"],
    };
    const writer = new SessionSnapshotStore();
    writer.write(sessionKey, persisted);
    await writer.flush();

    const memoryCache: ChatMessageCache = new Map();
    const store = new SessionSnapshotStore(memoryCache);
    store.connect();
    observeChatCache(memoryCache, store);
    try {
      appendChatMessageToCache(
        memoryCache,
        { assistantAgentId: "main", agentsList: null, hello: null },
        { sessionKey },
        "newest",
      );
      await store.flush();

      expect(await new SessionSnapshotStore().read(sessionKey)).toEqual(persisted);
    } finally {
      store.disconnect();
      await store.whenIdle();
    }
  });

  it("seeds the savedAt index once for every synchronous lookup", async () => {
    const writer = new SessionSnapshotStore();
    writer.write("agent:main:first", snapshot("first"));
    writer.write("agent:main:second", snapshot("second"));
    await writer.flush();
    const open = vi.spyOn(indexedDB, "open");
    const reader = new SessionSnapshotStore();

    await reader.loadSavedAtIndex();
    expect(reader.readSavedAt("agent:main:first")).not.toBeNull();
    expect(reader.readSavedAt("agent:main:second")).not.toBeNull();
    expect(reader.readSavedAt("agent:main:missing")).toBeNull();
    await reader.loadSavedAtIndex();

    expect(open).toHaveBeenCalledOnce();
  });

  it("defers snapshot sanitization until flush", async () => {
    const sessionKey = "agent:main:deferred-sanitize";
    const writer = new SessionSnapshotStore();
    writer.write(sessionKey, snapshot("persisted"));
    await writer.flush();

    writer.write(sessionKey, snapshot(1n));

    await writer.flush();
    expect(await new SessionSnapshotStore().read(sessionKey)).toBeNull();
  });

  it("does not write a snapshot back after pure hydration", async () => {
    let now = 1;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const sessionKey = "agent:main:hydrate-only";
    const writer = new SessionSnapshotStore();
    writer.write(sessionKey, snapshot("persisted"));
    await writer.flush();
    expect((await readRawRecord(sessionKey))?.savedAt).toBe(1);

    now = 2;
    const memoryCache: ChatMessageCache = new Map();
    const reader = new SessionSnapshotStore(memoryCache);
    observeChatCache(memoryCache, reader);
    const hydrated = await reader.read(sessionKey);
    if (!hydrated) {
      throw new Error("expected hydrated snapshot");
    }
    cacheChatSessionSnapshot(
      memoryCache,
      { assistantAgentId: "main", agentsList: null, hello: null },
      { sessionKey },
      hydrated,
    );
    await reader.flush();

    expect((await readRawRecord(sessionKey))?.savedAt).toBe(1);
  });

  it("evicts the oldest sessions by count and total serialized weight", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => ++now);
    const writer = new SessionSnapshotStore();
    for (let index = 0; index <= 20; index += 1) {
      writer.write(`agent:main:count-${index}`, snapshot(index, `count-${index}`));
      await writer.flush();
    }
    const reader = new SessionSnapshotStore();
    expect(writer.readSavedAt("agent:main:count-0")).toBeNull();
    expect(await reader.read("agent:main:count-0")).toBeNull();
    expect(await reader.read("agent:main:count-20")).not.toBeNull();

    await clearStoredChatSnapshots();
    const large = "x".repeat(9 * 1024 * 1024);
    for (let index = 0; index < 3; index += 1) {
      writer.write(`agent:main:weight-${index}`, snapshot(large, `weight-${index}`));
      await writer.flush();
    }
    const weightReader = new SessionSnapshotStore();
    expect(await weightReader.read("agent:main:weight-0")).toBeNull();
    expect(await weightReader.read("agent:main:weight-2")).not.toBeNull();
  });

  it("resets the whole database when the savedAt seed finds a malformed record", async () => {
    const writer = new SessionSnapshotStore();
    writer.write("agent:main:valid", snapshot("valid"));
    await writer.flush();
    await putRawRecord({
      sessionKey: "agent:main:corrupt",
      sessionId: "session-1",
      savedAt: Date.now(),
      snapshot: { messages: "not-an-array" },
    });

    const reader = new SessionSnapshotStore();
    await reader.loadSavedAtIndex();
    expect(reader.readSavedAt("agent:main:corrupt")).toBeNull();
    expect(await reader.read("agent:main:valid")).toBeNull();
  });

  it("deletes only the invalidated session record", async () => {
    const writer = new SessionSnapshotStore();
    writer.write("agent:main:deleted", snapshot("deleted"));
    writer.write("agent:main:retained", snapshot("retained"));
    await writer.flush();

    await writer.delete("agent:main:deleted");
    expect(writer.readSavedAt("agent:main:deleted")).toBeNull();
    expect(writer.readSavedAt("agent:main:retained")).not.toBeNull();

    const reader = new SessionSnapshotStore();
    expect(await reader.read("agent:main:deleted")).toBeNull();
    expect(await reader.read("agent:main:retained")).not.toBeNull();
  });

  it("upgrades a version one database before deleting an invalidated snapshot", async () => {
    const sessionKey = "agent:main:legacy-delete";
    await putVersionOneRecord(sessionKey);

    await new SessionSnapshotStore().delete(sessionKey);

    const request = indexedDB.open(CHAT_SNAPSHOT_DB_NAME);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () =>
        reject(request.error ?? new Error("database open failed")),
      );
    });
    expect(database.version).toBe(2);
    expect(Array.from(database.objectStoreNames)).toEqual([
      CHAT_SNAPSHOT_METADATA_STORE_NAME,
      CHAT_SNAPSHOT_STORE_NAME,
    ]);
    const transaction = database.transaction(
      [CHAT_SNAPSHOT_STORE_NAME, CHAT_SNAPSHOT_METADATA_STORE_NAME],
      "readonly",
    );
    const snapshotRequest = transaction.objectStore(CHAT_SNAPSHOT_STORE_NAME).get(sessionKey);
    const metadataRequest = transaction
      .objectStore(CHAT_SNAPSHOT_METADATA_STORE_NAME)
      .get(sessionKey);
    const completed = transactionDone(transaction);
    await Promise.all([
      new Promise<void>((resolve) => {
        snapshotRequest.addEventListener("success", () => resolve());
      }),
      new Promise<void>((resolve) => {
        metadataRequest.addEventListener("success", () => resolve());
      }),
      completed,
    ]);
    expect(snapshotRequest.result).toBeUndefined();
    expect(metadataRequest.result).toBeUndefined();
    database.close();
  });

  it("broadcasts invalidation and clears active memory for a peer-tab signal", async () => {
    const sessionKey = "agent:main:cross-tab";
    const memoryCache: ChatMessageCache = new Map();
    const store = new SessionSnapshotStore(memoryCache);
    store.connect();
    observeChatCache(memoryCache, store);
    cacheChatSessionSnapshot(
      memoryCache,
      { assistantAgentId: "main", agentsList: null, hello: null },
      { sessionKey },
      snapshot("local"),
    );
    await store.flush();
    const setItem = vi.spyOn(localStorage, "setItem");

    try {
      await clearStoredChatSnapshots();
      expect(setItem).toHaveBeenCalledWith(
        "openclaw.control.chatSnapshots.invalidate.v1",
        expect.any(String),
      );

      cacheChatSessionSnapshot(
        memoryCache,
        { assistantAgentId: "main", agentsList: null, hello: null },
        { sessionKey },
        snapshot("refilled"),
      );
      await store.flush();
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "openclaw.control.chatSnapshots.invalidate.v1",
          newValue: "other-tab",
        }),
      );

      expect(memoryCache.size).toBe(0);
      expect(store.readSavedAt(sessionKey)).toBeNull();
    } finally {
      store.disconnect();
      await store.whenIdle();
    }
  });

  it("keeps every operation non-fatal when IndexedDB is unavailable or throws", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const unavailable = new SessionSnapshotStore();
    unavailable.write("agent:main:none", snapshot("none"));
    await expect(unavailable.flush()).resolves.toBeUndefined();
    await expect(unavailable.read("agent:main:none")).resolves.toBeNull();
    await expect(unavailable.delete("agent:main:none")).resolves.toBeUndefined();

    vi.stubGlobal("indexedDB", {
      open: () => {
        throw new DOMException("denied", "SecurityError");
      },
      deleteDatabase: () => {
        throw new DOMException("denied", "SecurityError");
      },
    });
    const denied = new SessionSnapshotStore();
    denied.write("agent:main:denied", snapshot("denied"));
    await expect(denied.flush()).resolves.toBeUndefined();
    await expect(denied.read("agent:main:denied")).resolves.toBeNull();
    await expect(clearStoredChatSnapshots()).resolves.toBeUndefined();
  });
});
