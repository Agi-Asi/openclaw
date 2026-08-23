import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import {
  acceptPreparedSubagentLaunch,
  prepareSubagentLaunchRecord,
  reserveSubagentLaunchRecord,
} from "./subagent-launch-reservation.store.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function reservedRun(fingerprint = "sha256:first"): SubagentRunRecord {
  return {
    runId: "swarm_stable",
    taskRunId: "swarm_stable",
    childSessionKey: "agent:worker:subagent:stable",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    requesterAgentId: "main",
    task: "collect",
    cleanup: "delete",
    collect: true,
    swarmRequesterSessionKey: "agent:main:main",
    swarmRunId: "swarm_stable",
    schedulerSlotId: "swarm_stable",
    createdAt: 100,
    execution: { status: "queued" },
    completion: { required: false },
    delivery: { status: "not_required" },
    launch: {
      phase: "reserved",
      replayKey: "code-run:request-1",
      requestFingerprint: fingerprint,
      gatewayIdempotencyKey: "swarm_stable",
      childSessionId: "session_stable",
      childLifecycleRevision: "lifecycle_stable",
      revision: 0,
    },
  };
}

describe("subagent launch reservation store", () => {
  let stateDir = "";

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-launch-reservation-"));
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("inserts once, replays exact identity, and rejects a mismatched fingerprint", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const first = reserveSubagentLaunchRecord(reservedRun());
      expect(first.action).toBe("reserved");
      expect(reserveSubagentLaunchRecord(reservedRun()).action).toBe("replay");
      expect(reserveSubagentLaunchRecord(reservedRun("sha256:other")).action).toBe("conflict");
      expect(loadSubagentRegistryFromSqlite()).toHaveLength(1);
    });
  });

  it("serializes reservation authority across two SQLite connections", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      reserveSubagentLaunchRecord(reservedRun());
      const database = openOpenClawStateDatabase();
      database.db.exec("PRAGMA busy_timeout = 1");
      const contender = new DatabaseSync(database.path);
      try {
        contender.exec("PRAGMA busy_timeout = 1; BEGIN IMMEDIATE");
        expect(() =>
          reserveSubagentLaunchRecord({
            ...reservedRun(),
            runId: "swarm_contended",
            taskRunId: "swarm_contended",
          }),
        ).toThrow(/busy|locked/iu);
      } finally {
        contender.exec("ROLLBACK");
        contender.close();
      }
      expect(reserveSubagentLaunchRecord(reservedRun()).action).toBe("replay");
    });
  });

  it("CASes reserved to prepared and accepts without renaming the canonical run", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const reserved = reserveSubagentLaunchRecord(reservedRun()).entry;
      if (!reserved.launch) {
        throw new Error("expected reserved launch");
      }
      const prepared: SubagentRunRecord = {
        ...reserved,
        queuedLaunch: {
          request: { idempotencyKey: reserved.runId },
          timeoutMs: 1000,
          schedulerGroupKey: "group",
          maxConcurrent: 1,
        },
        launch: {
          ...reserved.launch,
          phase: "prepared",
          revision: 1,
          preparedAt: 200,
        },
      };
      expect(prepareSubagentLaunchRecord({ expected: reserved, prepared }).launch?.phase).toBe(
        "prepared",
      );
      const accepted = acceptPreparedSubagentLaunch({
        runId: reserved.runId,
        gatewayRunId: "gateway-owned",
      });
      expect(accepted).toMatchObject({
        runId: "swarm_stable",
        gatewayRunId: "gateway-owned",
        execution: { status: "running" },
      });
      expect(accepted?.launch).toBeUndefined();
      expect(accepted?.queuedLaunch).toBeUndefined();
    });
  });
});
