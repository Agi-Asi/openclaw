import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  admitAuthorizedMemoryDerivationMock,
  commitSealedSqliteTranscriptCompactionMock,
  isMemoryIsolationCutoverAgentMock,
  loadCompactHooksHarness,
  prepareAuthorizedSealedCompactionHostMock,
  readAuthorizedTranscriptDerivationMock,
  resetCompactHooksHarnessMocks,
  sealedCompactionCommitMock,
  sealedCompactionStageMock,
  sessionApplyDeferredCompactionMock,
  sessionAutomaticCompactionMock,
  sessionDeferredCompactionMock,
  sessionDiscardDeferredCompactionMock,
  sessionManualCompactionMock,
} from "./compact.hooks.harness.js";

let compactEmbeddedAgentSessionDirect: typeof import("./compact.js").compactEmbeddedAgentSessionDirect;

beforeAll(async () => {
  ({ compactEmbeddedAgentSessionDirect } = await loadCompactHooksHarness());
});

beforeEach(() => {
  resetCompactHooksHarnessMocks();
});

describe("sealed embedded compaction", () => {
  it("stages and commits the summary before applying its in-memory transcript entry", async () => {
    const source = {
      eventSeqs: [0, 1],
      sourcePolicySetId: "policy-set-1",
      deliveryAudiencesJson: '[{"kind":"user","id":"alice"}]',
    };
    isMemoryIsolationCutoverAgentMock.mockReturnValue(true);
    admitAuthorizedMemoryDerivationMock.mockResolvedValue(true);
    readAuthorizedTranscriptDerivationMock.mockReturnValue(source);
    prepareAuthorizedSealedCompactionHostMock.mockResolvedValue({
      source: { kind: "transcript", sessionId: "session-1", ...source },
      stage: sealedCompactionStageMock,
    });

    const result = await compactEmbeddedAgentSessionDirect({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile: "agent:main:session-1",
      sessionTarget: {
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        storePath: "/tmp/sessions.json",
      },
      workspaceDir: "/tmp",
      provider: "openai",
      model: "gpt-5.5",
      enqueue: async <T>(task: () => Promise<T> | T) => await task(),
    });

    expect(result).toMatchObject({ ok: true, compacted: true });
    expect(sessionDeferredCompactionMock).toHaveBeenCalledOnce();
    expect(sessionManualCompactionMock).not.toHaveBeenCalled();
    expect(sessionAutomaticCompactionMock).not.toHaveBeenCalled();
    expect(sealedCompactionStageMock).toHaveBeenCalledWith("summary");
    expect(commitSealedSqliteTranscriptCompactionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ id: "sealed-compaction-entry", summary: "summary" }),
        source,
        checkpoint: expect.objectContaining({
          preCompaction: expect.objectContaining({ entryId: "entry-1" }),
          postCompaction: expect.objectContaining({ entryId: "sealed-compaction-entry" }),
        }),
      }),
    );
    expect(sealedCompactionCommitMock).toHaveBeenCalledWith(
      expect.objectContaining({ compactionPolicyId: expect.any(String), eventSeq: 7 }),
    );
    expect(sessionApplyDeferredCompactionMock).toHaveBeenCalledOnce();
    expect(sessionDiscardDeferredCompactionMock).not.toHaveBeenCalled();
  });
});
