// Regression tests for legacy task-sidecar row normalization.
// Covers #130017: cron tasks with status="reconciling" must be settled as
// lost/not_applicable/silent at the migration boundary instead of being
// carried forward as nonterminal rows.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { readLegacyTaskRows } from "./state-migrations.task-sidecar-rows.js";

let tmpDir: string | undefined;

function makeLegacyDb(rows: Record<string, unknown>[]): string {
  tmpDir ??= fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sidecar-test-"));
  const dbPath = path.join(
    tmpDir,
    `legacy-tasks-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE task_runs (
      task_id TEXT NOT NULL,
      runtime TEXT NOT NULL,
      task_kind TEXT,
      source_id TEXT,
      requester_session_key TEXT,
      owner_key TEXT,
      scope_kind TEXT,
      child_session_key TEXT,
      parent_flow_id TEXT,
      parent_task_id TEXT,
      agent_id TEXT,
      requester_agent_id TEXT,
      run_id TEXT,
      label TEXT,
      task TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      delivery_status TEXT NOT NULL DEFAULT '',
      notify_policy TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER,
      ended_at INTEGER,
      last_event_at INTEGER,
      cleanup_after INTEGER,
      error TEXT,
      progress_summary TEXT,
      terminal_summary TEXT,
      terminal_outcome TEXT,
      detail_json TEXT
    )
  `);
  const stmt = db.prepare(`
    INSERT INTO task_runs (
      task_id, runtime, task_kind, source_id, owner_key, scope_kind,
      task, status, delivery_status, notify_policy, created_at
    ) VALUES (
      @task_id, @runtime, @task_kind, @source_id, @owner_key, @scope_kind,
      @task, @status, @delivery_status, @notify_policy, @created_at
    )
  `);
  for (const row of rows) {
    stmt.run({
      task_id: row.task_id ?? "task-001",
      runtime: row.runtime ?? "cron",
      task_kind: row.task_kind ?? "cron",
      source_id: row.source_id ?? "job-001",
      owner_key: row.owner_key ?? "system:cron:job-001",
      scope_kind: row.scope_kind ?? "system",
      task: row.task ?? "{}",
      status: row.status ?? "reconciling",
      delivery_status: row.delivery_status ?? "pending",
      notify_policy: row.notify_policy ?? "done_only",
      created_at: row.created_at ?? 1_000,
    } as Record<string, unknown>);
  }
  db.close();
  return dbPath;
}

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe("readLegacyTaskRows cron reconciling settlement", () => {
  it("settles a cron reconciling row to lost/not_applicable/silent at migration boundary", () => {
    // Regression for #130017: a cron task with status="reconciling" had no
    // surviving runtime after restart and must not be imported as nonterminal.
    const dbPath = makeLegacyDb([
      {
        task_id: "cron-recon-001",
        runtime: "cron",
        status: "reconciling",
        delivery_status: "pending",
        notify_policy: "done_only",
      },
    ]);
    const rows = readLegacyTaskRows(dbPath);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.status).toBe("lost");
    expect(row?.delivery_status).toBe("not_applicable");
    expect(row?.notify_policy).toBe("silent");
  });

  it("does not settle a cron task that reached a terminal status before migration", () => {
    // A cron task that legitimately completed should keep its original status.
    const dbPath = makeLegacyDb([
      {
        task_id: "cron-done-001",
        runtime: "cron",
        status: "done",
        delivery_status: "delivered",
        notify_policy: "done_only",
      },
    ]);
    const rows = readLegacyTaskRows(dbPath);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.status).toBe("done");
    expect(row?.delivery_status).toBe("delivered");
    expect(row?.notify_policy).toBe("done_only");
  });

  it("does not settle a non-cron reconciling row", () => {
    // Only cron tasks are affected; other runtimes do not hit this settlement.
    const dbPath = makeLegacyDb([
      {
        task_id: "subagent-recon-001",
        runtime: "subagent",
        status: "reconciling",
        delivery_status: "pending",
        notify_policy: "done_only",
      },
    ]);
    const rows = readLegacyTaskRows(dbPath);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.status).toBe("reconciling");
    expect(row?.delivery_status).toBe("pending");
    expect(row?.notify_policy).toBe("done_only");
  });

  it("settles only the cron reconciling row when mixed with other rows", () => {
    // Unrelated task rows must remain unchanged.
    const dbPath = makeLegacyDb([
      {
        task_id: "cron-recon-002",
        runtime: "cron",
        status: "reconciling",
        delivery_status: "pending",
        notify_policy: "done_only",
        created_at: 1_000,
      },
      {
        task_id: "cron-done-002",
        runtime: "cron",
        status: "done",
        delivery_status: "delivered",
        notify_policy: "done_only",
        created_at: 2_000,
      },
    ]);
    const rows = readLegacyTaskRows(dbPath);
    expect(rows).toHaveLength(2);
    const recon = rows.find((r) => r.task_id === "cron-recon-002");
    const done = rows.find((r) => r.task_id === "cron-done-002");
    expect(recon?.status).toBe("lost");
    expect(recon?.delivery_status).toBe("not_applicable");
    expect(recon?.notify_policy).toBe("silent");
    expect(done?.status).toBe("done");
    expect(done?.delivery_status).toBe("delivered");
    expect(done?.notify_policy).toBe("done_only");
  });
});
