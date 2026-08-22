import type { ApprovalDocumentMode } from "./approval-deep-link.ts";

type SavedTranscriptProbeHost = {
  readonly basePath: string | undefined;
  readonly credentialAction: 0 | 2;
  readonly documentMode: ApprovalDocumentMode | null;
  readonly focusDocument: boolean;
  markSavedTranscriptReady(): void;
};

// Startup-side read of the persistent transcript cache: decides whether this
// document can paint its saved conversation during the first connect instead
// of the full-document splash. Lives behind a lazy boundary so splash-only
// documents never pay for the session-path parser or the cache in the boot
// chunk.
export async function probeSavedTranscript(host: SavedTranscriptProbeHost): Promise<void> {
  if (host.credentialAction !== 0) {
    if (host.credentialAction === 2) {
      const { clearStoredChatSnapshots } =
        await import("../pages/chat/session-snapshot-invalidation.runtime.ts");
      await clearStoredChatSnapshots();
    }
    return;
  }
  if (host.documentMode !== null || host.focusDocument) {
    return;
  }
  // Only an explicit literal chat route can name the exact conversation
  // without gateway defaults or first-run routing.
  const { sessionRefFromPath } = await import("../app-session-route-paths.ts");
  const direct = sessionRefFromPath(globalThis.location?.pathname ?? "", host.basePath ?? "");
  const candidate =
    direct?.namespace === "chat" && direct.kind === "literal" ? direct.sessionKey : null;
  if (!candidate) {
    return;
  }
  const [{ resolveChatSnapshotKey }, { readStoredChatSnapshot }] = await Promise.all([
    import("../pages/chat/session-snapshot-invalidation.ts"),
    import("../pages/chat/session-snapshot-store.ts"),
  ]);
  const snapshot = await readStoredChatSnapshot(
    resolveChatSnapshotKey(
      { assistantAgentId: null, agentsList: null, hello: null },
      { sessionKey: candidate },
    ),
  );
  if (snapshot && snapshot.messages.length > 0) {
    host.markSavedTranscriptReady();
  }
}
