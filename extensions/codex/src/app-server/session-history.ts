/**
 * Reads OpenClaw session history for Codex transcript mirroring and sanitizes
 * image payloads before replaying messages into the app-server projector.
 */
import fs from "node:fs/promises";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { SessionEntry } from "openclaw/plugin-sdk/agent-sessions";
import {
  buildSessionContext,
  migrateSessionEntries,
  parseSessionEntries,
} from "openclaw/plugin-sdk/agent-sessions";
import { readCodexSessionTranscriptBoundedContextBeforeAdmission } from "openclaw/plugin-sdk/codex-session-transcript-runtime";
import {
  getSessionEntry,
  parseSqliteSessionFileMarker,
  resolveTranscriptSessionKeyBySessionId,
  type SqliteSessionFileMarker,
} from "openclaw/plugin-sdk/session-store-runtime";
import {
  readSessionTranscriptBoundedActiveContext,
  type TranscriptTurnAdmission,
  type SessionTranscriptTargetParams,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { sanitizeCodexHistoryImagePayloads } from "./image-payload-sanitizer.js";

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

export type CodexMirroredSessionHistoryTarget = {
  agentId?: string;
  contextTokenBudget?: number;
  sessionFile: string;
  sessionId: string;
  sessionKey?: string;
  sessionTarget?: Partial<SessionTranscriptTargetParams>;
};

const DEFAULT_CODEX_HISTORY_CONTEXT_TOKENS = 128_000;
const MAX_CODEX_HISTORY_CONTEXT_BYTES = 64 * 1024 * 1024;
const MAX_CODEX_HISTORY_CONTEXT_EVENTS = 10_000;

function resolveCodexHistoryContextLimits(target: CodexMirroredSessionHistoryTarget): {
  maxBytes: number;
  maxEvents: number;
} {
  const tokenBudget =
    typeof target.contextTokenBudget === "number" &&
    Number.isFinite(target.contextTokenBudget) &&
    target.contextTokenBudget > 0
      ? Math.floor(target.contextTokenBudget)
      : DEFAULT_CODEX_HISTORY_CONTEXT_TOKENS;
  return {
    maxBytes: Math.min(MAX_CODEX_HISTORY_CONTEXT_BYTES, Math.max(1024 * 1024, tokenBudget * 8)),
    maxEvents: MAX_CODEX_HISTORY_CONTEXT_EVENTS,
  };
}

async function readBoundedCodexSessionEntries(
  target: SessionTranscriptTargetParams,
  limits: { maxBytes: number; maxEvents: number },
  admission?: TranscriptTurnAdmission,
): Promise<unknown[]> {
  const context = admission
    ? await readCodexSessionTranscriptBoundedContextBeforeAdmission(
        { ...target, ...limits },
        admission,
      )
    : readSessionTranscriptBoundedActiveContext({ ...target, ...limits });
  return context.events;
}

/** Returns sanitized session-context messages for a Codex mirrored session file. */
export async function readCodexMirroredSessionHistoryMessages(
  target: CodexMirroredSessionHistoryTarget,
  admission?: TranscriptTurnAdmission,
): Promise<AgentMessage[] | undefined> {
  try {
    const entries = await readCodexMirroredSessionEntries(target, admission);
    if (entries.length === 0) {
      return [];
    }
    const firstEntry = entries[0] as { type?: unknown; id?: unknown } | undefined;
    if (firstEntry?.type !== "session") {
      // A well-formed transcript that does not open with a `session` marker is
      // simply not a Codex-mirrored session (e.g. a non-Codex model run reusing
      // this hook) — an empty mirror, not a read failure, so callers must not
      // warn. `undefined` stays reserved for genuine failures: read/parse errors
      // (caught below) and malformed `session` headers (next check).
      return [];
    }
    if (typeof firstEntry.id !== "string") {
      // A `session` header without a string id is a corrupted Codex transcript,
      // not a foreign one — keep it on the warn path.
      return undefined;
    }
    if (firstEntry.id !== target.sessionId) {
      return [];
    }
    migrateSessionEntries(entries);
    const sessionEntries = entries.filter((entry): entry is SessionEntry => {
      return (
        entry !== null &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        (entry as { type?: unknown }).type !== "session"
      );
    });
    return sanitizeCodexHistoryImagePayloads(
      buildSessionContext(sessionEntries).messages,
      "codex mirrored history",
    );
  } catch (error) {
    // A new Codex session can be read before its transcript exists; other failures still warn.
    if (isMissingFileError(error)) {
      return [];
    }
    return undefined;
  }
}

async function readCodexMirroredSessionEntries(
  target: CodexMirroredSessionHistoryTarget,
  admission?: TranscriptTurnAdmission,
): Promise<SessionEntry[]> {
  const limits = resolveCodexHistoryContextLimits(target);
  if (target.sessionTarget) {
    const { agentId, sessionId, sessionKey, storePath } = target.sessionTarget;
    if (
      !agentId ||
      !sessionId ||
      !sessionKey ||
      !storePath ||
      sessionId !== target.sessionId ||
      (target.agentId !== undefined && agentId !== target.agentId) ||
      (target.sessionKey !== undefined && sessionKey !== target.sessionKey)
    ) {
      return [];
    }
    const transcriptTarget = {
      agentId,
      sessionId,
      sessionKey,
      storePath,
    };
    return (await readBoundedCodexSessionEntries(
      transcriptTarget,
      limits,
      admission,
    )) as SessionEntry[];
  }
  const sqliteMarker = parseSqliteSessionFileMarker(target.sessionFile);
  if (sqliteMarker) {
    if (
      sqliteMarker.sessionId !== target.sessionId ||
      (target.agentId !== undefined && sqliteMarker.agentId !== target.agentId)
    ) {
      return [];
    }
    const sessionKey = resolveSqliteMarkerSessionKey(target, sqliteMarker);
    if (!sessionKey) {
      return [];
    }
    const transcriptTarget = {
      agentId: sqliteMarker.agentId,
      sessionId: sqliteMarker.sessionId,
      sessionKey,
      storePath: sqliteMarker.storePath,
    };
    return (await readBoundedCodexSessionEntries(
      transcriptTarget,
      limits,
      admission,
    )) as SessionEntry[];
  }
  if (admission) {
    if (
      admission.sessionId !== target.sessionId ||
      (target.agentId !== undefined && admission.agentId !== target.agentId) ||
      (target.sessionKey !== undefined && admission.sessionKey !== target.sessionKey)
    ) {
      return [];
    }
    return (await readBoundedCodexSessionEntries(
      {
        agentId: admission.agentId,
        sessionId: admission.sessionId,
        sessionKey: admission.sessionKey,
        storePath: admission.storePath,
      },
      limits,
      admission,
    )) as SessionEntry[];
  }
  return parseSessionEntries(await fs.readFile(target.sessionFile, "utf-8")) as SessionEntry[];
}

function resolveSqliteMarkerSessionKey(
  target: CodexMirroredSessionHistoryTarget,
  marker: SqliteSessionFileMarker,
): string | undefined {
  const explicitSessionKey = target.sessionKey?.trim();
  if (explicitSessionKey) {
    // The SDK exact-entry accessor uses a read-only database handle.
    const explicitEntry = getSessionEntry({
      agentId: marker.agentId,
      sessionKey: explicitSessionKey,
      storePath: marker.storePath,
    });
    if (explicitEntry) {
      return explicitEntry.sessionId === marker.sessionId ? explicitSessionKey : undefined;
    }
  }
  return resolveTranscriptSessionKeyBySessionId({
    agentId: marker.agentId,
    sessionId: marker.sessionId,
    storePath: marker.storePath,
  });
}
