import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  replaceSessionEntry,
  replaceTranscriptEvents,
} from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { readTrajectoryDetail, readTrajectoryPage } from "./read-model.js";
import { appendSqliteTrajectoryRuntimeEvents } from "./runtime-store.sqlite.js";
import type { TrajectoryEvent } from "./types.js";

describe("trajectory read model", () => {
  let tempDir: string;
  let storePath: string;
  const sessionKey = "agent:main:main";
  const sessionId = "trajectory-session";

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-trajectory-read-"));
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
    await replaceSessionEntry(
      { sessionKey, storePath },
      { sessionId, updatedAt: Date.parse("2026-08-22T12:00:00.000Z") },
    );
    await replaceTranscriptEvents({ agentId: "main", sessionId, sessionKey, storePath }, [
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026-08-22T12:00:01.000Z",
        message: { role: "user", content: "Inspect the deployment", timestamp: 1 },
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp: "2026-08-22T12:00:04.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Deployment is healthy." }],
          api: "openai-responses",
          provider: "openai",
          model: "gpt-5.6-luna",
          usage: {
            input: 12,
            output: 4,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 16,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 4,
        },
      },
    ]);
    appendSqliteTrajectoryRuntimeEvents({ agentId: "main", sessionId, storePath }, [
      runtimeEvent("session.started", "2026-08-22T12:00:02.000Z"),
      runtimeEvent("model.completed", "2026-08-22T12:00:03.000Z", {
        usage: { input: 12, output: 4 },
      }),
    ]);
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("pages the merged durable timeline without duplicating semantic rows", () => {
    const target = { agentId: "main", sessionId, sessionKey, storePath };
    const tail = readTrajectoryPage({ target, limit: 2 });

    expect(tail.records.map((record) => record.id)).toEqual([
      "runtime:1",
      "transcript:assistant-1",
    ]);
    expect(tail.hasMore).toBe(true);
    expect(tail.cursor).toBeTruthy();

    const earlier = readTrajectoryPage({ target, cursor: tail.cursor, limit: 2 });
    expect(earlier.records.map((record) => record.id)).toEqual(["transcript:user-1", "runtime:0"]);
    expect(new Set([...earlier.records, ...tail.records].map((record) => record.id)).size).toBe(4);
  });

  it("returns a bounded display detail for a selected transcript record", () => {
    const result = readTrajectoryDetail({
      target: { agentId: "main", sessionId, sessionKey, storePath },
      recordId: "transcript:assistant-1",
    });

    expect(result).toMatchObject({
      ok: true,
      record: {
        id: "transcript:assistant-1",
        kind: "assistant",
        provider: "openai",
        model: "gpt-5.6-luna",
      },
    });
    expect(JSON.stringify(result.detail)).toContain("Deployment is healthy.");
  });

  it("reports the existing capture override without hiding transcript facts", () => {
    const result = readTrajectoryPage({
      target: { agentId: "main", sessionId, sessionKey, storePath },
      env: { OPENCLAW_TRAJECTORY: "0" },
    });

    expect(result.capture).toBe("disabled");
    expect(result.records.some((record) => record.kind === "user")).toBe(true);
  });

  function runtimeEvent(type: string, ts: string, data?: Record<string, unknown>): TrajectoryEvent {
    return {
      traceSchema: "openclaw-trajectory",
      schemaVersion: 1,
      traceId: sessionId,
      source: "runtime",
      type,
      ts,
      seq: 1,
      sessionId,
      sessionKey,
      runId: "run-1",
      provider: "openai",
      modelId: "gpt-5.6-luna",
      ...(data ? { data } : {}),
    };
  }
});
