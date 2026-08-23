import { isDeepStrictEqual } from "node:util";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import {
  bindTaskDeliveryState,
  bindTaskRecord,
  insertOrMatchTaskRowsInDatabase,
} from "../../../tasks/task-registry.store.sqlite.js";
import type { TaskDeliveryState, TaskRecord } from "../../../tasks/task-registry.types.js";
import {
  bindSubagentRunRecord,
  insertOrMatchSubagentRunRowInDatabase,
  rowToSubagentRunRecord,
} from "./subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type ReservationDatabase = Pick<OpenClawStateKyselyDatabase, "subagent_runs">;

function query(database: OpenClawStateDatabase) {
  return getNodeSqliteKysely<ReservationDatabase>(database.db);
}

function readRun(database: OpenClawStateDatabase, runId: string): SubagentRunRecord | undefined {
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    query(database).selectFrom("subagent_runs").selectAll().where("run_id", "=", runId),
  );
  return row ? (rowToSubagentRunRecord(row) ?? undefined) : undefined;
}

function sameLaunchRequest(left: SubagentRunRecord, right: SubagentRunRecord): boolean {
  return Boolean(
    left.launch &&
    right.launch &&
    left.runId === right.runId &&
    left.requesterAgentId === right.requesterAgentId &&
    left.requesterSessionKey === right.requesterSessionKey &&
    left.launch.replayKey === right.launch.replayKey &&
    left.launch.requestFingerprint === right.launch.requestFingerprint &&
    left.launch.gatewayIdempotencyKey === right.launch.gatewayIdempotencyKey &&
    left.childSessionKey === right.childSessionKey &&
    left.launch.childSessionId === right.launch.childSessionId &&
    left.launch.childLifecycleRevision === right.launch.childLifecycleRevision,
  );
}

export function reserveSubagentLaunchRecord(
  entry: SubagentRunRecord,
):
  | { action: "reserved"; entry: SubagentRunRecord }
  | { action: "replay"; entry: SubagentRunRecord }
  | { action: "conflict"; entry: SubagentRunRecord } {
  if (entry.launch?.phase !== "reserved" || entry.execution.status !== "queued") {
    throw new Error("subagent launch reservation requires a canonical reserved row");
  }
  return runOpenClawStateWriteTransaction((database) => {
    const current = readRun(database, entry.runId);
    if (current) {
      return sameLaunchRequest(current, entry)
        ? { action: "replay", entry: current }
        : { action: "conflict", entry: current };
    }
    insertOrMatchSubagentRunRowInDatabase(database, bindSubagentRunRecord(entry));
    const stored = readRun(database, entry.runId);
    if (!stored) {
      throw new Error(`subagent launch reservation disappeared ${entry.runId}`);
    }
    return { action: "reserved", entry: stored };
  });
}

export function prepareSubagentLaunchRecord(params: {
  expected: SubagentRunRecord;
  prepared: SubagentRunRecord;
  task?: TaskRecord;
  taskDelivery?: TaskDeliveryState;
}): SubagentRunRecord {
  if (
    params.expected.launch?.phase !== "reserved" ||
    params.prepared.launch?.phase !== "prepared" ||
    params.prepared.launch.revision !== params.expected.launch.revision + 1 ||
    !sameLaunchRequest(params.expected, params.prepared)
  ) {
    throw new Error("subagent launch preparation identity mismatch");
  }
  const expected = bindSubagentRunRecord(params.expected);
  const prepared = bindSubagentRunRecord(params.prepared);
  return runOpenClawStateWriteTransaction((database) => {
    const current = readRun(database, params.expected.runId);
    if (current && isDeepStrictEqual(current, params.prepared)) {
      return current;
    }
    if (!current || !isDeepStrictEqual(current, params.expected)) {
      throw new Error(`subagent launch preparation lost reservation ${params.expected.runId}`);
    }
    if (params.task) {
      insertOrMatchTaskRowsInDatabase(
        database,
        bindTaskRecord(params.task),
        params.taskDelivery ? bindTaskDeliveryState(params.taskDelivery) : undefined,
      );
    }
    const { run_id: _runId, ...update } = prepared;
    const result = executeSqliteQuerySync(
      database.db,
      query(database)
        .updateTable("subagent_runs")
        .set(update)
        .where("run_id", "=", expected.run_id)
        .where("payload_json", "=", expected.payload_json),
    );
    if (result.numAffectedRows !== 1n) {
      throw new Error(`subagent launch preparation lost CAS ${params.expected.runId}`);
    }
    return params.prepared;
  });
}

export function acceptPreparedSubagentLaunch(params: {
  runId: string;
  gatewayRunId: string;
}): SubagentRunRecord | undefined {
  return runOpenClawStateWriteTransaction((database) => {
    const current = readRun(database, params.runId);
    if (!current) {
      return undefined;
    }
    if (!current.launch) {
      return current.gatewayRunId === params.gatewayRunId ? current : undefined;
    }
    if (current.launch.phase !== "prepared") {
      return undefined;
    }
    const acceptedAt = Date.now();
    const next: SubagentRunRecord = {
      ...current,
      gatewayRunId: params.gatewayRunId,
      launch: undefined,
      queuedLaunch: undefined,
      execution: {
        ...current.execution,
        status: "running",
        acceptedAt,
        startedAt: current.execution.startedAt ?? acceptedAt,
      },
      sessionStartedAt: current.sessionStartedAt ?? acceptedAt,
    };
    delete next.launch;
    const expected = bindSubagentRunRecord(current);
    const accepted = bindSubagentRunRecord(next);
    const { run_id: _runId, ...update } = accepted;
    const result = executeSqliteQuerySync(
      database.db,
      query(database)
        .updateTable("subagent_runs")
        .set(update)
        .where("run_id", "=", current.runId)
        .where("payload_json", "=", expected.payload_json),
    );
    if (result.numAffectedRows !== 1n) {
      throw new Error(`subagent launch acceptance lost CAS ${current.runId}`);
    }
    return next;
  });
}
