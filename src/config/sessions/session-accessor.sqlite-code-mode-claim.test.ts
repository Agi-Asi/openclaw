import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { attachCodeModeWaitingClaimMutation } from "./code-mode-waiting-claim.js";
import { loadSessionEntryReadOnly, loadTranscriptEventsSync } from "./session-accessor.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { appendTranscriptMessageSync } from "./session-accessor.sqlite-transcript-write.js";

const tempDirs: string[] = [];

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

  function waitingMessage(runId: string, eventId: string) {
    const details = { status: "waiting", runId };
    attachCodeModeWaitingClaimMutation(details, {
      kind: "set",
      waitingCodeModeRunId: runId,
      expiresAt: Date.now() + 60_000,
    });
    return {
      eventId,
      message: {
        role: "toolResult",
        toolCallId: `exec-${runId}`,
        toolName: "exec",
        content: [{ type: "text", text: "waiting" }],
        details,
      },
    };
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

    const details = { status: "completed" };
    attachCodeModeWaitingClaimMutation(details, {
      kind: "clear",
      waitingCodeModeRunId: "run-a",
    });
    appendTranscriptMessageSync(scope, {
      eventId: "terminal-a",
      message: {
        role: "toolResult",
        toolCallId: "wait-run-a",
        toolName: "wait",
        content: [{ type: "text", text: "completed" }],
        details,
      },
    });
    expect(loadSessionEntryReadOnly(scope)?.codeModeWaitingClaims).toBeUndefined();
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
});
