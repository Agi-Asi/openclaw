import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";

export const MAX_CODE_MODE_WAITING_CLAIM_MS = 30 * 60_000;
export const MAX_CODE_MODE_WAITING_CLAIMS = 64;
export const CODE_MODE_WAITING_CLAIM_MUTATION = Symbol.for("openclaw.codeModeWaitingClaimMutation");

export type CodeModeWaitingClaim = {
  sourceSessionId: string;
  sourceLifecycleRevision: string;
  sourceWriterRunId: string;
  sourceToolCallId: string;
  waitingCodeModeRunId: string;
  expiresAt: number;
  transcriptAnchor: TranscriptEntryAnchor;
  transcriptEventDigest: string;
};

export type CodeModeWaitingClaims = Record<string, CodeModeWaitingClaim>;
export type CodeModeWaitingClaimMutation =
  | { kind: "set"; waitingCodeModeRunId: string; expiresAt: number }
  | { kind: "clear"; waitingCodeModeRunId: string };

export function attachCodeModeWaitingClaimMutation(
  details: object,
  mutation: CodeModeWaitingClaimMutation,
): void {
  Object.defineProperty(details, CODE_MODE_WAITING_CLAIM_MUTATION, {
    configurable: true,
    enumerable: false,
    value: mutation,
  });
}

export function readCodeModeWaitingClaimMutation(
  details: unknown,
): CodeModeWaitingClaimMutation | undefined {
  if (!details || typeof details !== "object") {
    return undefined;
  }
  return (details as Record<PropertyKey, unknown>)[CODE_MODE_WAITING_CLAIM_MUTATION] as
    | CodeModeWaitingClaimMutation
    | undefined;
}
