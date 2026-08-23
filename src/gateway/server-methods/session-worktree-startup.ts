import { StringDecoder } from "node:string_decoder";
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type {
  SessionStartupStage,
  SessionStartupState,
} from "../../../packages/gateway-protocol/src/index.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { ChatAttachment } from "../chat-attachments.js";
import type { prepareWorktreeSessionTitle } from "../dashboard-session-title.js";
import {
  resolveSessionCreateModelSelection,
  type createGatewaySession,
} from "../session-create-service.js";
import type { PreparedGatewaySessionLifecycle } from "../session-lifecycle-preparation.js";
import {
  registerSessionStartupOperation,
  type RegisteredSessionStartupOperation,
} from "../session-startup-operations.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import { handleDirectExternalChatSend } from "./chat-send-external-entry.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { sessionLog } from "./sessions-shared.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type CreatedGatewaySession = Extract<
  Awaited<ReturnType<typeof createGatewaySession>>,
  { ok: true }
>;
type PrepareLifecycle = NonNullable<Parameters<typeof createGatewaySession>[0]["prepareLifecycle"]>;
type InitializingStartupState = Extract<SessionStartupState, { status: "initializing" }>;
const STARTUP_ATTACHMENT_METADATA_MAX_ITEMS = 32;
const STARTUP_OUTPUT_MAX_LENGTH = 16_384;

function appendStartupOutput(current: string, chunk: string): string {
  const combined = `${current}${chunk}`;
  return combined.length <= STARTUP_OUTPUT_MAX_LENGTH
    ? combined
    : sliceUtf16Safe(combined, combined.length - STARTUP_OUTPUT_MAX_LENGTH);
}

export type SessionWorktreeStartupRuntime = {
  control?: RegisteredSessionStartupOperation;
  commitGuard?: () => void;
  reportStage?: (stage: SessionStartupStage) => Promise<void>;
  reportOutput?: (chunk: Buffer) => void;
};

export function buildInitializingWorktreeStartup(params: {
  attachments?: ChatAttachment[];
  message?: string;
  operationId?: string;
  startedAt: number;
}): SessionStartupState | undefined {
  if (!params.operationId) {
    return undefined;
  }
  return {
    kind: "managed-worktree",
    status: "initializing",
    operationId: params.operationId,
    stage: "queued",
    startedAt: params.startedAt,
    updatedAt: params.startedAt,
    ...(params.message || params.attachments
      ? {
          initialTurn: {
            ...(params.message ? { message: truncateUtf16Safe(params.message, 100_000) } : {}),
            ...(params.attachments
              ? {
                  attachments: params.attachments
                    .slice(0, STARTUP_ATTACHMENT_METADATA_MAX_ITEMS)
                    .map(({ content: _content, ...metadata }) => metadata),
                }
              : {}),
          },
        }
      : {}),
  };
}

export async function startSessionWorktreeStartup(params: {
  cfg: Parameters<typeof resolveSessionCreateModelSelection>[0];
  client: GatewayRequestHandlerOptions["client"];
  commitGuard?: () => void;
  context: GatewayRequestHandlerOptions["context"];
  created: CreatedGatewaySession;
  hasInitialTurn: boolean;
  initialAttachments?: ChatAttachment[];
  initialMessage?: string;
  isWebchatConnect: GatewayRequestHandlerOptions["isWebchatConnect"];
  prepareLifecycle: PrepareLifecycle;
  req: GatewayRequestHandlerOptions["req"];
  respond: GatewayRequestHandlerOptions["respond"];
  runtime: SessionWorktreeStartupRuntime;
  sourceCwd?: string;
  sourceRoot?: string;
  startedAt: number;
  startupOperationId: string;
  titleModelTarget: Parameters<typeof resolveSessionCreateModelSelection>[2];
  worktreeTitle: () => ReturnType<typeof prepareWorktreeSessionTitle>;
}): Promise<void> {
  const {
    cfg,
    client,
    commitGuard,
    context,
    created,
    hasInitialTurn,
    initialAttachments,
    initialMessage,
    isWebchatConnect,
    prepareLifecycle,
    req,
    respond,
    runtime,
    sourceCwd,
    sourceRoot,
    startedAt,
    startupOperationId,
    titleModelTarget,
    worktreeTitle,
  } = params;
  const createdEntry = created.entry;
  const storePath = loadGatewaySessionEntryReadOnly(created.key, {
    agentId: created.agentId,
  }).storePath;
  runtime.control = registerSessionStartupOperation({
    key: created.key,
    lifecycleRevision: createdEntry.lifecycleRevision,
    operationId: startupOperationId,
    sessionId: createdEntry.sessionId,
  });

  const assertLifecycleOwner = () => {
    const entry = loadGatewaySessionEntryReadOnly(created.key, { agentId: created.agentId }).entry;
    if (
      entry?.sessionId !== createdEntry.sessionId ||
      entry.lifecycleRevision !== createdEntry.lifecycleRevision ||
      entry.startupState?.operationId !== startupOperationId
    ) {
      throw new Error("session startup no longer owns the current lifecycle");
    }
  };
  const assertStartupCurrent = () => {
    runtime.control?.signal.throwIfAborted();
    assertLifecycleOwner();
  };
  const assertAuthorizedOwner = () => {
    commitGuard?.();
    assertLifecycleOwner();
  };
  const assertActiveStartup = () => {
    // Background setup retains both the caller's revocable authority and the exact
    // session generation across fetch, checkout, provisioning, and setup awaits.
    assertAuthorizedOwner();
    runtime.control?.signal.throwIfAborted();
  };
  runtime.commitGuard = assertActiveStartup;

  const updateStartup = async (patch: Partial<InitializingStartupState>) => {
    const updated = await patchSessionEntryCore(
      { agentId: created.agentId, sessionKey: created.key, storePath },
      (entry) => {
        if (
          entry.sessionId !== createdEntry.sessionId ||
          entry.lifecycleRevision !== createdEntry.lifecycleRevision ||
          entry.startupState?.operationId !== startupOperationId ||
          entry.startupState.status !== "initializing"
        ) {
          return null;
        }
        return { startupState: { ...entry.startupState, ...patch } };
      },
      { preserveActivity: true },
    );
    if (updated?.startupState?.operationId !== startupOperationId) {
      return false;
    }
    emitSessionsChanged(context, {
      sessionKey: created.key,
      agentId: created.agentId,
      reason: "create",
    });
    return true;
  };

  let startupOutput = createdEntry.startupState?.output ?? "";
  const outputDecoder = new StringDecoder("utf8");
  let outputFlushed = false;
  let updateQueue = Promise.resolve(true);
  const queueUpdate = (patch: Partial<InitializingStartupState>) => {
    updateQueue = updateQueue.catch(() => false).then(async () => await updateStartup(patch));
    return updateQueue;
  };
  runtime.reportStage = async (stage) => {
    if (!(await queueUpdate({ stage, updatedAt: Date.now() }))) {
      throw new Error("session startup no longer owns the current lifecycle");
    }
  };
  let pendingOutput: Pick<InitializingStartupState, "output" | "updatedAt"> | undefined;
  let outputUpdateScheduled = false;
  const scheduleOutputUpdate = () => {
    pendingOutput = { output: startupOutput, updatedAt: Date.now() };
    if (outputUpdateScheduled) {
      return updateQueue;
    }
    outputUpdateScheduled = true;
    updateQueue = updateQueue
      .catch(() => false)
      .then(async () => {
        let updated = true;
        while (pendingOutput && updated) {
          const patch = pendingOutput;
          pendingOutput = undefined;
          updated = await updateStartup(patch);
        }
        outputUpdateScheduled = false;
        return updated;
      });
    return updateQueue;
  };
  runtime.reportOutput = (chunk) => {
    const nextOutput = appendStartupOutput(startupOutput, outputDecoder.write(chunk));
    if (nextOutput === startupOutput) {
      return;
    }
    startupOutput = nextOutput;
    void scheduleOutputUpdate();
  };
  const flushStartupOutput = async () => {
    if (!outputFlushed) {
      outputFlushed = true;
      const nextOutput = appendStartupOutput(startupOutput, outputDecoder.end());
      if (nextOutput !== startupOutput) {
        startupOutput = nextOutput;
        void scheduleOutputUpdate();
      }
    }
    await updateQueue;
  };

  const admission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: [created.key, createdEntry.sessionId],
    assertAllowed: assertStartupCurrent,
    onInterrupt: () =>
      runtime.control?.interrupt(new Error("session lifecycle replaced worktree startup")),
  });
  respond(
    true,
    {
      ok: true,
      key: created.key,
      sessionId: createdEntry.sessionId,
      entry: createdEntry,
      resolved: created.resolved,
      runStarted: false,
      startupState: createdEntry.startupState,
    },
    undefined,
  );
  emitSessionsChanged(context, {
    sessionKey: created.key,
    agentId: created.agentId,
    reason: "create",
  });

  const persistTerminal = async (
    state: SessionStartupState,
    binding?: {
      sessionRoot?: string;
      spawnedCwd?: string;
      worktree?: typeof createdEntry.worktree;
    },
    guard?: () => void,
    preservePending = false,
  ) =>
    await patchSessionEntryCore(
      { agentId: created.agentId, sessionKey: created.key, storePath },
      (entry) => {
        guard?.();
        if (
          entry.sessionId !== createdEntry.sessionId ||
          entry.lifecycleRevision !== createdEntry.lifecycleRevision ||
          entry.startupState?.operationId !== startupOperationId
        ) {
          return null;
        }
        const next = preservePending
          ? entry
          : (({ initializationPending: _pending, ...terminal }) => terminal)(entry);
        return { ...next, ...binding, startupState: state };
      },
      { preserveActivity: true, replaceEntry: true },
    );

  const dispatchInitialTurn = async (dispatchGuard: () => void): Promise<void> => {
    if (!hasInitialTurn) {
      const cleared = await patchSessionEntryCore(
        { agentId: created.agentId, sessionKey: created.key, storePath },
        (entry) => {
          dispatchGuard();
          if (
            entry.sessionId !== createdEntry.sessionId ||
            entry.lifecycleRevision !== createdEntry.lifecycleRevision ||
            entry.startupState?.operationId !== startupOperationId
          ) {
            return null;
          }
          const { initializationPending: _pending, startupState: _startupState, ...next } = entry;
          return next;
        },
        { preserveActivity: true, replaceEntry: true },
      );
      if (!cleared) {
        throw new Error("session startup no longer owns the current lifecycle");
      }
      return;
    }

    let accepted = false;
    let dispatchError: unknown;
    let releaseDispatchSettlement: (() => void) | undefined;
    const startupStateCleared = new Promise<void>((resolve) => {
      releaseDispatchSettlement = resolve;
    });
    const persistDispatchFailure = async (
      error: unknown,
      dispatchIdentity: { lifecycleRevision?: string; sessionId: string },
    ) => {
      const failedAt = Date.now();
      const updated = await patchSessionEntryCore(
        { agentId: created.agentId, sessionKey: created.key, storePath },
        (entry) => {
          if (
            entry.sessionId !== dispatchIdentity.sessionId ||
            entry.lifecycleRevision !== dispatchIdentity.lifecycleRevision ||
            (entry.startupState !== undefined &&
              entry.startupState.operationId !== startupOperationId)
          ) {
            return null;
          }
          const { initializationPending: _pending, ...next } = entry;
          return {
            ...next,
            startupState: {
              ...createdEntry.startupState,
              kind: "managed-worktree",
              status: "failed",
              operationId: startupOperationId,
              stage: "running-setup",
              startedAt,
              updatedAt: failedAt,
              error: `Initial message failed: ${formatErrorMessage(error)}`.slice(0, 512),
              retryable: false,
              ...(startupOutput ? { output: startupOutput } : {}),
            },
          };
        },
        { preserveActivity: true, replaceEntry: true },
      );
      if (updated) {
        emitSessionsChanged(context, {
          sessionKey: created.key,
          agentId: created.agentId,
          reason: "send",
        });
      }
    };
    const dispatchIdentityReady = createDeferredCore<{
      lifecycleRevision?: string;
      sessionId: string;
    }>();
    await handleDirectExternalChatSend(
      {
        req,
        params: {
          sessionKey: created.key,
          agentId: created.agentId,
          message: initialMessage ?? "",
          idempotencyKey: startupOperationId,
          ...(initialAttachments ? { attachments: initialAttachments } : {}),
        },
        respond: (ok, _payload, error) => {
          accepted = ok;
          dispatchError = error;
        },
        context,
        client,
        isWebchatConnect,
      },
      async () => {
        try {
          dispatchGuard();
          return true;
        } catch {
          return false;
        }
      },
      async (outcome) => {
        await startupStateCleared;
        const dispatchIdentity = await dispatchIdentityReady.promise;
        if (!outcome.ok) {
          await persistDispatchFailure(outcome.error, dispatchIdentity);
        }
      },
    );
    const admittedEntry = loadGatewaySessionEntryReadOnly(created.key, {
      agentId: created.agentId,
    }).entry;
    if (!admittedEntry || admittedEntry.sessionId !== createdEntry.sessionId) {
      throw new Error("initial turn no longer owns the created session");
    }
    const dispatchIdentity = {
      lifecycleRevision: admittedEntry.lifecycleRevision,
      sessionId: admittedEntry.sessionId,
    };
    dispatchIdentityReady.resolve(dispatchIdentity);
    if (!accepted) {
      await persistDispatchFailure(dispatchError ?? "dispatch rejected", dispatchIdentity);
      return;
    }
    let cleared: Awaited<ReturnType<typeof patchSessionEntryCore>>;
    try {
      cleared = await patchSessionEntryCore(
        { agentId: created.agentId, sessionKey: created.key, storePath },
        (entry) => {
          if (
            entry.sessionId !== dispatchIdentity.sessionId ||
            entry.lifecycleRevision !== dispatchIdentity.lifecycleRevision ||
            entry.startupState?.operationId !== startupOperationId
          ) {
            return null;
          }
          const { initializationPending: _pending, startupState: _startupState, ...next } = entry;
          return next;
        },
        { preserveActivity: true, replaceEntry: true },
      );
    } finally {
      releaseDispatchSettlement?.();
    }
    if (cleared) {
      emitSessionsChanged(context, {
        sessionKey: created.key,
        agentId: created.agentId,
        reason: "send",
      });
    }
  };

  void admission
    .run(async () => {
      let preparedLifecycle: PreparedGatewaySessionLifecycle | undefined;
      try {
        await runtime.reportStage?.("preparing");
        const prepared = await prepareLifecycle({
          agentId: created.agentId,
          entry: createdEntry,
          key: created.key,
          storePath,
          titleModelSelection: resolveSessionCreateModelSelection(
            cfg,
            created.agentId,
            titleModelTarget,
            createdEntry,
          ),
        });
        if (!prepared.ok) {
          throw new Error(prepared.error.message);
        }
        preparedLifecycle = prepared.value;
        await flushStartupOutput();
        assertActiveStartup();
        const completedState: SessionStartupState = {
          ...createdEntry.startupState,
          kind: "managed-worktree",
          status: "completed",
          operationId: startupOperationId,
          stage: "running-setup",
          startedAt,
          updatedAt: Date.now(),
          worktreePath: preparedLifecycle.spawnedCwd ?? preparedLifecycle.sessionRoot ?? "worktree",
          ...(startupOutput ? { output: startupOutput } : {}),
        };
        const finalized = await persistTerminal(
          completedState,
          {
            spawnedCwd: preparedLifecycle.spawnedCwd,
            sessionRoot: preparedLifecycle.sessionRoot,
            worktree: preparedLifecycle.worktree,
          },
          assertActiveStartup,
          true,
        );
        if (!finalized) {
          await preparedLifecycle.rollback?.();
          return;
        }
        emitSessionsChanged(context, {
          sessionKey: created.key,
          agentId: created.agentId,
          reason: "create",
        });
        if (
          await worktreeTitle()?.persist(
            created.agentId,
            finalized,
            created.key,
            storePath,
            assertActiveStartup,
          )
        ) {
          emitSessionsChanged(context, {
            sessionKey: created.key,
            agentId: created.agentId,
            reason: "chat.title",
          });
        }
        const admitted = await patchSessionEntryCore(
          { agentId: created.agentId, sessionKey: created.key, storePath },
          (entry) => {
            assertActiveStartup();
            if (
              entry.sessionId !== createdEntry.sessionId ||
              entry.lifecycleRevision !== createdEntry.lifecycleRevision ||
              entry.initializationPending !== true ||
              entry.startupState?.status !== "completed" ||
              entry.startupState.operationId !== startupOperationId
            ) {
              return null;
            }
            const { initializationPending: _pending, ...next } = entry;
            return next;
          },
          { preserveActivity: true, replaceEntry: true },
        );
        if (!admitted) {
          throw new Error("initial turn no longer owns the completed startup");
        }
        await dispatchInitialTurn(assertActiveStartup);
      } catch (error) {
        await flushStartupOutput();
        const current = loadGatewaySessionEntryReadOnly(created.key, {
          agentId: created.agentId,
        }).entry;
        const state = current?.startupState;
        if (
          current?.sessionId !== createdEntry.sessionId ||
          current.lifecycleRevision !== createdEntry.lifecycleRevision ||
          state?.operationId !== startupOperationId
        ) {
          await preparedLifecycle?.rollback?.();
          return;
        }
        const resolution = runtime.control?.resolution();
        const updatedAt = Date.now();
        if (resolution === "cancel") {
          await preparedLifecycle?.rollback?.();
          await persistTerminal({
            ...state,
            status: "cancelled",
            updatedAt,
            result: "Worktree setup cancelled. The initial message was not sent.",
          });
          return;
        }
        if (resolution === "work-local") {
          await preparedLifecycle?.rollback?.();
          const local = await persistTerminal(
            {
              ...state,
              status: "local",
              updatedAt,
              result: "Continuing in the existing workspace.",
            },
            { spawnedCwd: sourceCwd, sessionRoot: sourceRoot },
          );
          if (local) {
            await dispatchInitialTurn(assertAuthorizedOwner);
          }
          return;
        }
        await preparedLifecycle?.rollback?.();
        await persistTerminal(
          {
            ...state,
            status: "failed",
            updatedAt,
            error: formatErrorMessage(error).slice(0, 512) || "Worktree setup failed",
            retryable: false,
          },
          { spawnedCwd: sourceCwd, sessionRoot: sourceRoot },
        );
      } finally {
        runtime.control?.release();
        admission.release();
        emitSessionsChanged(context, {
          sessionKey: created.key,
          agentId: created.agentId,
          reason: "create",
        });
      }
    })
    .catch((error: unknown) => {
      sessionLog.warn(`session startup lifecycle failed: ${formatErrorMessage(error)}`);
    });
}
