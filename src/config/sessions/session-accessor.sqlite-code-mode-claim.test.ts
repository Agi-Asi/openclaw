import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  attachCodeModeWaitingClaimMutation,
  type CodeModeWaitingClaim,
  MAX_CODE_MODE_WAITING_CLAIM_MS,
  MAX_CODE_MODE_WAITING_CLAIMS,
} from "./code-mode-waiting-claim.js";
import { loadSessionEntryReadOnly, loadTranscriptEventsSync } from "./session-accessor.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  appendExpectedSessionTranscriptTurn,
  appendTranscriptMessageSync,
} from "./session-accessor.sqlite-transcript-write.js";
import { projectPublicSessionEntry } from "./session-entry-projection.js";
import type { InternalSessionEntry } from "./types.js";

const claimWarningMock = vi.hoisted(() => vi.fn());

vi.mock("../../logging/subsystem.js", async () => {
  const actual = await vi.importActual<typeof import("../../logging/subsystem.js")>(
    "../../logging/subsystem.js",
  );
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "sessions/code-mode-claim"
        ? { ...logger, warn: claimWarningMock }
        : logger;
    },
  };
});

const tempDirs: string[] = [];

// Source-equivalent v2026.8.1-beta.2 semantics: known retired fields are removed
// while unknown fields survive a full JSON rewrite. This does not run the package.
function rewriteWithBeta2UnknownFieldSemantics(raw: string): InternalSessionEntry {
  const value = JSON.parse(raw) as Record<string, unknown>;
  const {
    icon: _icon,
    sessionFile: _sessionFile,
    transcriptPath: _transcriptPath,
    pendingFinalDeliveryLastAttemptAt: _lastAttempt,
    pendingFinalDeliveryAttemptCount: _attemptCount,
    pendingFinalDeliveryLastError: _lastError,
    memoryFlushAt: _memoryFlushAt,
    memoryFlushContextHash: _memoryFlushContextHash,
    memoryFlushLastFailedAt: _memoryFlushLastFailedAt,
    memoryFlushLastFailureError: _memoryFlushLastFailureError,
    ...canonicalValue
  } = value;
  return {
    ...canonicalValue,
    label: "rewritten by beta.2",
    updatedAt: Date.now(),
  } as InternalSessionEntry;
}

function projectWithBeta2UnknownFieldSemantics(
  entry: InternalSessionEntry,
): Record<string, unknown> {
  const {
    activeWriterRunId: _activeWriterRunId,
    mainRestartRecovery: _mainRestartRecovery,
    ...publicEntry
  } = entry;
  return publicEntry;
}

describe("SQLite Code Mode waiting claims", () => {
  let scope: {
    agentId: string;
    expectedLifecycleRevision: string;
    expectedWriterRunId: string;
    sessionId: string;
    sessionKey: string;
    storePath: string;
  };

  beforeEach(() => {
    claimWarningMock.mockReset();
    scope = {
      agentId: "main",
      expectedLifecycleRevision: "lifecycle-a",
      expectedWriterRunId: "writer-a",
      sessionId: "session-a",
      sessionKey: "agent:main:code-mode-claim",
      storePath: path.join(makeTempDir(tempDirs, "code-mode-claim-"), "sessions.json"),
    };
    replaceSessionEntrySync(scope, {
      activeWriterRunId: "writer-a",
      lifecycleRevision: "lifecycle-a",
      sessionId: "session-a",
      updatedAt: 1,
    });
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    cleanupTempDirs(tempDirs);
  });

  function waitingMessage(
    runId: string,
    eventId: string,
    options: { expiresAt?: number; toolCallId?: string; toolName?: string } = {},
  ) {
    const details = { status: "waiting", runId };
    attachCodeModeWaitingClaimMutation(details, {
      kind: "set",
      waitingCodeModeRunId: runId,
      expiresAt: options.expiresAt ?? Date.now() + 60_000,
    });
    return {
      eventId,
      message: {
        role: "toolResult",
        toolCallId: options.toolCallId ?? `exec-${runId}`,
        toolName: options.toolName ?? "exec",
        content: [{ type: "text", text: "waiting" }],
        details,
      },
    };
  }

  function claims() {
    return loadSessionEntryReadOnly(scope)?.codeModeWaitingClaims;
  }

  function appendTerminal(
    runId: string,
    expectedClaim: CodeModeWaitingClaim,
    eventId = `terminal-${runId}`,
    writeScope = scope,
  ) {
    const details = { status: "completed" };
    attachCodeModeWaitingClaimMutation(details, {
      kind: "clear",
      waitingCodeModeRunId: runId,
      expectedClaim,
    });
    return appendTranscriptMessageSync(writeScope, {
      eventId,
      message: {
        role: "toolResult",
        toolCallId: `wait-${runId}`,
        toolName: "wait",
        content: [{ type: "text", text: "completed" }],
        details,
      },
    });
  }

  function rewriteRawEvent(seq: number): void {
    const resolved = resolveSqliteTranscriptScope(scope);
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const db = getSessionKysely(database.db);
    const raw = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("transcript_events")
        .select("event_json")
        .where("session_id", "=", scope.sessionId)
        .where("seq", "=", seq),
    )?.event_json;
    if (!raw) {
      throw new Error("missing raw transcript event");
    }
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("transcript_events")
        .set({ event_json: JSON.stringify({ ...JSON.parse(raw), rewritten: true }) })
        .where("session_id", "=", scope.sessionId)
        .where("seq", "=", seq),
    );
  }

  function rewriteActiveMessagePosition(seq: number): void {
    const resolved = resolveSqliteTranscriptScope(scope);
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const db = getSessionKysely(database.db);
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("session_transcript_active_events")
        .set({ message_position: 99 })
        .where("session_id", "=", scope.sessionId)
        .where("event_seq", "=", seq),
    );
  }

  it("records and clears exact transcript-owned claim authority", () => {
    appendTranscriptMessageSync(scope, waitingMessage("run-a", "waiting-a"));
    const claim = loadSessionEntryReadOnly(scope)?.codeModeWaitingClaims?.["run-a"];
    expect(claim).toMatchObject({
      sourceSessionId: "session-a",
      sourceLifecycleRevision: "lifecycle-a",
      sourceWriterRunId: "writer-a",
      sourceToolCallId: "exec-run-a",
      waitingCodeModeRunId: "run-a",
      transcriptAnchor: {
        sessionId: "session-a",
        sessionKey: scope.sessionKey,
        entryId: "waiting-a",
      },
    });
    expect(claim?.transcriptEventDigest).toMatch(/^[a-f0-9]{64}$/u);

    appendTerminal("run-a", claim!, "terminal-a");
    expect(loadSessionEntryReadOnly(scope)?.codeModeWaitingClaims).toBeUndefined();
  });

  it("survives source-equivalent beta.2 unknown-field rewrites", () => {
    appendTranscriptMessageSync(scope, waitingMessage("run-beta2", "waiting-beta2"));
    const expectedClaim = claims()?.["run-beta2"];
    expect(expectedClaim).toBeDefined();
    closeOpenClawAgentDatabasesForTest();
    const resolved = resolveSqliteTranscriptScope(scope);
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const db = getSessionKysely(database.db);
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("session_nodes")
        .select("entry_json")
        .where("session_key", "=", scope.sessionKey),
    );
    if (!row) {
      throw new Error("missing beta.2 compatibility row");
    }
    const rewritten = rewriteWithBeta2UnknownFieldSemantics(row.entry_json);
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("session_nodes")
        .set({ entry_json: JSON.stringify(rewritten), updated_at: rewritten.updatedAt })
        .where("session_key", "=", scope.sessionKey),
    );
    database.db
      .prepare("UPDATE session_nodes SET entry_valid=1 WHERE session_key=?")
      .run(scope.sessionKey);
    closeOpenClawAgentDatabasesForTest();
    const reopened = loadSessionEntryReadOnly(scope) as InternalSessionEntry;
    expect(reopened.codeModeWaitingClaims?.["run-beta2"]).toEqual(expectedClaim);
    expect(projectPublicSessionEntry(reopened)).not.toHaveProperty("codeModeWaitingClaims");
    // The beta.2 source projection exposed unknown fields, including this opaque,
    // non-secret claim. The plugin writer test owns current projection filtering.
    expect(projectWithBeta2UnknownFieldSemantics(rewritten).codeModeWaitingClaims).toEqual({
      "run-beta2": expectedClaim,
    });
    expect(Object.keys(expectedClaim!).toSorted()).toEqual([
      "expiresAt",
      "sourceLifecycleRevision",
      "sourceSessionId",
      "sourceToolCallId",
      "sourceWriterRunId",
      "transcriptAnchor",
      "transcriptEventDigest",
      "waitingCodeModeRunId",
    ]);

    appendTerminal("run-beta2", expectedClaim!, "terminal-beta2");
    expect(claims()).toBeUndefined();
  });

  it("drops a claim safely across an intentional full replacement", () => {
    appendTranscriptMessageSync(scope, waitingMessage("run-replaced", "waiting-replaced"));
    const replacedClaim = claims()?.["run-replaced"];
    expect(replacedClaim).toBeDefined();

    replaceSessionEntrySync(scope, {
      activeWriterRunId: scope.expectedWriterRunId,
      lifecycleRevision: scope.expectedLifecycleRevision,
      sessionId: scope.sessionId,
      updatedAt: Date.now(),
    });
    expect(claims()).toBeUndefined();

    appendTerminal("run-replaced", replacedClaim!, "terminal-after-replacement");
    expect(claims()).toBeUndefined();
  });

  it("clamps claim expiry and rejects already-expired mutations", () => {
    const startedAt = Date.now();
    appendTranscriptMessageSync(
      scope,
      waitingMessage("run-clamped", "waiting-clamped", {
        expiresAt: startedAt + MAX_CODE_MODE_WAITING_CLAIM_MS * 2,
      }),
    );
    const clamped = claims()?.["run-clamped"];
    expect(clamped?.expiresAt).toBeGreaterThan(startedAt);
    expect(clamped?.expiresAt).toBeLessThanOrEqual(
      startedAt + MAX_CODE_MODE_WAITING_CLAIM_MS + 100,
    );

    appendTranscriptMessageSync(
      scope,
      waitingMessage("run-expired", "waiting-expired", { expiresAt: Date.now() - 1 }),
    );
    expect(claims()).not.toHaveProperty("run-expired");
  });

  it("bounds active claims, preserves every transcript result, and warns once", () => {
    for (let index = 0; index < MAX_CODE_MODE_WAITING_CLAIMS + 2; index += 1) {
      appendTranscriptMessageSync(scope, waitingMessage(`run-${index}`, `waiting-${index}`));
    }

    expect(Object.keys(claims() ?? {})).toHaveLength(MAX_CODE_MODE_WAITING_CLAIMS);
    expect(
      loadTranscriptEventsSync(scope).filter((event) => event.type === "message"),
    ).toHaveLength(MAX_CODE_MODE_WAITING_CLAIMS + 2);
    expect(claimWarningMock).toHaveBeenCalledTimes(1);
  });

  it("replaces a re-wait claim and rejects a late clear from the earlier claim", () => {
    appendTranscriptMessageSync(
      scope,
      waitingMessage("run-a", "waiting-a-1", { toolCallId: "exec-a" }),
    );
    const first = claims()?.["run-a"];
    appendTranscriptMessageSync(
      scope,
      waitingMessage("run-a", "waiting-a-2", {
        toolCallId: "wait-a",
        toolName: "wait",
      }),
    );
    const replacement = claims()?.["run-a"];

    expect(replacement?.sourceToolCallId).toBe("wait-a");
    expect(replacement?.transcriptEventDigest).not.toBe(first?.transcriptEventDigest);
    appendTerminal("run-a", first!, "late-terminal-a");
    expect(claims()?.["run-a"]).toEqual(replacement);
  });

  it.each(["lifecycle", "writer", "digest", "active-anchor"] as const)(
    "preserves exact claim authority when %s validation rejects a clear",
    (mismatch) => {
      appendTranscriptMessageSync(scope, waitingMessage("run-a", "waiting-a"));
      const claim = claims()?.["run-a"];
      if (!claim) {
        throw new Error("missing waiting claim");
      }
      let writeScope = scope;
      if (mismatch === "lifecycle") {
        replaceSessionEntrySync(scope, {
          ...loadSessionEntryReadOnly(scope)!,
          lifecycleRevision: "lifecycle-b",
        });
        writeScope = { ...scope, expectedLifecycleRevision: "lifecycle-b" };
      } else if (mismatch === "writer") {
        replaceSessionEntrySync(scope, {
          ...loadSessionEntryReadOnly(scope)!,
          activeWriterRunId: "writer-b",
        });
        writeScope = { ...scope, expectedWriterRunId: "writer-b" };
      } else if (mismatch === "digest") {
        rewriteRawEvent(claim.transcriptAnchor.rawSeq);
      } else {
        rewriteActiveMessagePosition(claim.transcriptAnchor.rawSeq);
      }

      appendTerminal("run-a", claim, `terminal-${mismatch}`, writeScope);
      expect(claims()?.["run-a"]).toEqual(claim);
    },
  );

  it("preserves context metadata and the prepared transcript root in an atomic turn", async () => {
    replaceSessionEntrySync(scope, {
      ...loadSessionEntryReadOnly(scope)!,
      contextWindow: "128k",
    });
    const waiting = waitingMessage("run-atomic", "waiting-atomic");

    await appendExpectedSessionTranscriptTurn(scope, {
      atomicGroup: true,
      expectedLifecycleRevision: scope.expectedLifecycleRevision,
      expectedSessionId: scope.sessionId,
      expectedWriterRunId: scope.expectedWriterRunId,
      messages: [waiting],
      sessionFile: scope.storePath,
      touchSessionEntry: true,
    });

    expect(loadSessionEntryReadOnly(scope)).toMatchObject({
      contextWindow: "128k",
      codeModeWaitingClaims: { "run-atomic": { waitingCodeModeRunId: "run-atomic" } },
    });
    const resolved = resolveSqliteTranscriptScope(scope);
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    expect(
      database.db
        .prepare("SELECT session_key FROM session_windows WHERE session_id = ?")
        .get(scope.sessionId),
    ).toEqual({ session_key: scope.sessionKey });
  });

  it("commits the truthful transcript append when claim persistence fails", () => {
    const resolved = resolveSqliteTranscriptScope(scope);
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    database.db.exec(`
      CREATE TRIGGER fail_code_mode_claim
      BEFORE UPDATE ON session_nodes
      BEGIN
        SELECT RAISE(ABORT, 'synthetic claim failure');
      END
    `);

    expect(() =>
      appendTranscriptMessageSync(scope, waitingMessage("run-failed", "waiting-failed")),
    ).not.toThrow();
    expect(loadSessionEntryReadOnly(scope)?.codeModeWaitingClaims).toBeUndefined();
    expect(
      loadTranscriptEventsSync(scope).some(
        (event) =>
          event.type === "message" &&
          "message" in event &&
          event.message &&
          typeof event.message === "object" &&
          "toolCallId" in event.message &&
          event.message.toolCallId === "exec-run-failed",
      ),
    ).toBe(true);
  });

  it("commits the terminal transcript append when claim clearing fails", () => {
    appendTranscriptMessageSync(scope, waitingMessage("run-clear-failed", "waiting-clear-failed"));
    const claim = claims()?.["run-clear-failed"];
    expect(claim).toBeDefined();
    const resolved = resolveSqliteTranscriptScope(scope);
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    database.db.exec(`
      CREATE TRIGGER fail_code_mode_claim_clear
      BEFORE UPDATE ON session_nodes
      BEGIN
        SELECT RAISE(ABORT, 'synthetic claim clear failure');
      END
    `);

    expect(() => appendTerminal("run-clear-failed", claim!, "terminal-clear-failed")).not.toThrow();
    expect(claims()?.["run-clear-failed"]).toEqual(claim);
    expect(
      loadTranscriptEventsSync(scope).some(
        (event) =>
          event.type === "message" &&
          "message" in event &&
          event.message &&
          typeof event.message === "object" &&
          "toolCallId" in event.message &&
          event.message.toolCallId === "wait-run-clear-failed",
      ),
    ).toBe(true);
    expect(claimWarningMock).toHaveBeenCalledWith(
      "Code Mode waiting claim failed; transcript append was preserved",
      { mutation: "clear" },
    );
  });
});
