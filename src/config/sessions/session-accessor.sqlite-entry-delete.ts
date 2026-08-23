import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import {
  deferOpenClawAgentPostCommitPublication,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { publishSessionEntryCacheInvalidation } from "./session-accessor.sqlite-entry-cache.js";
import { sqliteSessionEntriesEqual } from "./session-accessor.sqlite-entry-equality.js";
import { resolveLifecyclePrimaryEntry } from "./session-accessor.sqlite-entry-store.js";
import { prepareSessionDeletionFinalization } from "./session-accessor.sqlite-finalization.js";
import {
  copySessionNodeArtifactsForRepair,
  deleteSessionDeliveryArtifacts,
  deleteSessionNodeArtifacts,
} from "./session-accessor.sqlite-node-artifacts.js";
import { hasSqliteSessionOwnerColumns } from "./session-accessor.sqlite-owner-projection.js";
import { collectSessionStateIdsForEntry } from "./session-accessor.sqlite-references.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { parseSessionEntryJson as parseSessionEntryRow } from "./session-accessor.sqlite-status.js";
import type { SessionEntry } from "./types.js";

export function deleteSessionEntryRows(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  options: { deleteOwnedWindows?: boolean; deliveryCleanupKeys?: readonly string[] } = {},
): void {
  const db = getSessionKysely(database.db);
  const windows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_windows").select("session_id").where("session_key", "=", sessionKey),
  ).rows;
  const survivingNodes = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_nodes")
      .select(["current_session_id", "entry_json", "session_key"])
      .where("session_key", "!=", sessionKey)
      .orderBy("session_key", "asc"),
  ).rows;
  for (const window of windows) {
    const survivingNode = survivingNodes.find((node) => {
      if (node.current_session_id === window.session_id) {
        return true;
      }
      const entry = parseSessionEntryRow(node);
      return entry ? collectSessionStateIdsForEntry(entry).includes(window.session_id) : false;
    });
    if (survivingNode) {
      executeSqliteQuerySync(
        database.db,
        db
          .updateTable("session_windows")
          .set({ session_key: survivingNode.session_key })
          .where("session_id", "=", window.session_id),
      );
    }
  }
  if (options.deleteOwnedWindows) {
    deleteSessionDeliveryArtifacts(database, sessionKey, options.deliveryCleanupKeys);
    deleteSessionNodeArtifacts(database, sessionKey);
    captureSessionEntryDeletion(database, sessionKey);
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("session_nodes").where("session_key", "=", sessionKey),
    );
    publishSessionEntryCacheInvalidation(database);
    return;
  }
  const remainingWindow = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("session_windows")
      .select(["session_id", "updated_at"])
      .where("session_key", "=", sessionKey)
      .orderBy("updated_at", "desc")
      .orderBy("session_id", "asc")
      .limit(1),
  );
  if (remainingWindow) {
    deleteSessionNodeArtifacts(database, sessionKey);
    captureSessionEntryDeletion(database, sessionKey);
    clearSqliteSessionEntryPreservingWindows(database, {
      sessionId: remainingWindow.session_id,
      sessionKey,
      updatedAt: remainingWindow.updated_at,
    });
    publishSessionEntryCacheInvalidation(database);
    return;
  }
  captureSessionEntryDeletion(database, sessionKey);
  executeSqliteQuerySync(
    database.db,
    db.deleteFrom("session_nodes").where("session_key", "=", sessionKey),
  );
  publishSessionEntryCacheInvalidation(database);
}

/** Remove the logical entry while retaining its node-owned transcript windows. */
function clearSqliteSessionEntryPreservingWindows(
  database: OpenClawAgentDatabase,
  params: { sessionId: string; sessionKey: string; updatedAt: number },
): void {
  const db = getSessionKysely(database.db);
  const cleared = {
    current_session_id: params.sessionId,
    entry_json: "{}",
    entry_valid: -1,
    updated_at: params.updatedAt,
    status: null,
    created_at: null,
    created_via: null,
    created_actor_type: null,
    created_actor_id: null,
    project_id: null,
    parent_session_key: null,
    spawned_by: null,
    fork_source_session_key: null,
    fork_source_session_id: null,
    fork_source_entry_id: null,
    label: null,
    display_name: null,
    category: null,
    icon: null,
    pinned_at: null,
    archived_at: null,
    last_read_at: null,
    last_interaction_at: null,
    last_activity_at: null,
    ...(hasSqliteSessionOwnerColumns(database.db)
      ? {
          owner_actor_type: null,
          owner_actor_id: null,
          owner_assigned_by_type: null,
          owner_assigned_by_id: null,
          owner_assigned_at: null,
        }
      : {}),
  } as const;
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("session_nodes")
      .values({ session_key: params.sessionKey, ...cleared })
      .onConflict((conflict) => conflict.column("session_key").doUpdateSet(cleared)),
  );
  executeSqliteQuerySync(
    database.db,
    db
      .updateTable("session_nodes")
      .set({ entry_valid: -1 })
      .where("session_key", "=", params.sessionKey),
  );
}

export function deleteLifecycleTargetRows(
  database: OpenClawAgentDatabase,
  target: { canonicalKey: string; storeKeys: string[] },
): void {
  for (const sessionKey of uniqueStrings([target.canonicalKey, ...target.storeKeys])) {
    const trimmed = sessionKey.trim();
    if (trimmed) {
      deleteSessionEntryRows(database, trimmed);
    }
  }
}

export function assertLifecycleTargetUnchanged(
  database: OpenClawAgentDatabase,
  target: { canonicalKey: string; storeKeys: string[] },
  expectedEntry: SessionEntry | undefined,
  operation: "deleted" | "reset",
): void {
  const current = resolveLifecyclePrimaryEntry(database, target)?.entry;
  const matches =
    !current || !expectedEntry
      ? current === expectedEntry
      : sqliteSessionEntriesEqual(current, expectedEntry);
  if (!matches) {
    throw new Error(`SQLite session entry changed before ${operation} lifecycle mutation`);
  }
}

export function deleteLegacySessionEntryRows(
  database: OpenClawAgentDatabase,
  legacyKeys: string[],
  sessionKey: string,
  options: { rehomeMembers?: boolean } = {},
): void {
  if (legacyKeys.length === 0) {
    return;
  }
  const db = getSessionKysely(database.db);
  for (const legacyKey of legacyKeys) {
    if (legacyKey === sessionKey) {
      continue;
    }
    rehomeSessionWindows(database, sessionKey, [legacyKey]);
    copySessionNodeArtifactsForRepair(database, database, [legacyKey], sessionKey, {
      includeMembers: options.rehomeMembers,
    });
    captureSessionEntryDeletion(database, legacyKey);
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("session_nodes").where("session_key", "=", legacyKey),
    );
    publishSessionEntryCacheInvalidation(database);
  }
}

/** Capture the exact displaced owner before SQL removes or replaces its current row. */
export function captureSessionEntryDeletion(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  kind: "delete" | "replace" = "delete",
): void {
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("session_nodes")
      .leftJoin("session_windows", "session_windows.session_id", "session_nodes.current_session_id")
      .select([
        "session_nodes.current_session_id as current_session_id",
        "session_nodes.entry_json as entry_json",
        "session_windows.agent_harness_id as agent_harness_id",
      ])
      .where("session_nodes.session_key", "=", sessionKey),
  );
  const entry = row && parseSessionEntryRow(row);
  if (!row || !entry) {
    return;
  }
  const agentHarnessId = entry.agentHarnessId ?? row.agent_harness_id ?? undefined;
  const publish = prepareSessionDeletionFinalization({
    ...(agentHarnessId ? { agentHarnessId } : {}),
    kind,
    ...(entry.lifecycleRevision ? { lifecycleRevision: entry.lifecycleRevision } : {}),
    sessionId: entry.sessionId ?? row.current_session_id,
    sessionKey,
    isRetained: () =>
      Boolean(
        executeSqliteQueryTakeFirstSync(
          database.db,
          db
            .selectFrom("session_nodes")
            .select("session_key")
            .where("current_session_id", "=", row.current_session_id)
            .where("entry_valid", "!=", -1)
            .limit(1),
        ),
      ),
  });
  if (publish && !deferOpenClawAgentPostCommitPublication(database, publish)) {
    throw new Error(`session deletion requires a synchronous transaction for ${sessionKey}`);
  }
}

/** Move retained generations to the canonical node before removing key aliases. */
export function rehomeSessionWindows(
  database: OpenClawAgentDatabase,
  canonicalKey: string,
  previousKeys: Iterable<string>,
): void {
  const legacyKeys = uniqueStrings([...previousKeys].map((key) => key.trim())).filter(
    (key) => key && key !== canonicalKey,
  );
  if (legacyKeys.length === 0) {
    return;
  }
  const db = getSessionKysely(database.db);
  executeSqliteQuerySync(
    database.db,
    db
      .updateTable("session_windows")
      .set({ session_key: canonicalKey })
      .where("session_key", "in", legacyKeys),
  );
}
