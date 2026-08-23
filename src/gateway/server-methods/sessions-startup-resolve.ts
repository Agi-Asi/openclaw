import {
  ErrorCodes,
  errorShape,
  validateSessionsStartupResolveParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import {
  inspectSessionStartupOperation,
  resolveSessionStartupOperation,
} from "../session-startup-operations.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const sessionsStartupResolveHandler: GatewayRequestHandlers["sessions.startup.resolve"] =
  async ({ params, respond, context, sessionMutationAuthorization }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsStartupResolveParams,
        "sessions.startup.resolve",
        respond,
      )
    ) {
      return;
    }
    const p = params;
    const cfg = context.getRuntimeConfig();
    const requestedAgent = resolveRequestedSessionAgentId(cfg, p.key);
    if (!requestedAgent.ok) {
      respond(false, undefined, requestedAgent.error);
      return;
    }
    sessionMutationAuthorization?.assertCurrent();
    const current = loadGatewaySessionEntryReadOnly(p.key, {
      agentId: requestedAgent.agentId,
    });
    const startup = current.entry?.startupState;
    if (
      !current.entry ||
      (startup?.status !== "completed" && current.entry.initializationPending !== true) ||
      (startup?.status !== "initializing" && startup?.status !== "completed") ||
      startup.operationId !== p.operationId
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "session startup is no longer active"),
      );
      return;
    }
    const currentEntry = current.entry;
    const startupCompleted = startup.status === "completed";
    const operationIdentity = {
      key: current.canonicalKey,
      lifecycleRevision: currentEntry.lifecycleRevision,
      operationId: p.operationId,
      sessionId: currentEntry.sessionId,
    };
    const operationStatus = inspectSessionStartupOperation(operationIdentity);
    if (startupCompleted && operationStatus !== "missing") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          operationStatus === "active"
            ? "The initial message is still starting. Try again in a moment."
            : "session startup is no longer active",
        ),
      );
      return;
    }
    const resolution = startupCompleted
      ? "missing"
      : resolveSessionStartupOperation({ ...operationIdentity, action: p.action });
    if (resolution === "missing") {
      const updatedAt = Date.now();
      const recovered = await runExclusiveSessionLifecycleMutation({
        scope: current.storePath,
        identities: [current.canonicalKey, currentEntry.sessionId],
        run: async () => {
          sessionMutationAuthorization?.assertCurrent();
          const authoritative = loadGatewaySessionEntryReadOnly(current.canonicalKey, {
            agentId: requestedAgent.agentId,
          }).entry;
          if (
            !authoritative ||
            authoritative.sessionId !== currentEntry.sessionId ||
            authoritative.lifecycleRevision !== currentEntry.lifecycleRevision ||
            (startup.status !== "completed" && authoritative.initializationPending !== true) ||
            authoritative.startupState?.status !== startup.status ||
            authoritative.startupState.operationId !== p.operationId
          ) {
            return null;
          }
          if (!startupCompleted) {
            const interruptedWorktree = managedWorktrees.findLiveByOwner(
              "session",
              current.canonicalKey,
            );
            if (interruptedWorktree) {
              await managedWorktrees.remove({
                id: interruptedWorktree.id,
                reason: "session-startup-restarted",
                allowSnapshotLoss: true,
              });
            }
          }
          return await patchSessionEntryCore(
            {
              agentId: requestedAgent.agentId,
              sessionKey: current.canonicalKey,
              storePath: current.storePath,
            },
            (entry) => {
              sessionMutationAuthorization?.assertCurrent();
              if (
                entry.sessionId !== currentEntry.sessionId ||
                entry.lifecycleRevision !== currentEntry.lifecycleRevision ||
                (startup.status !== "completed" && entry.initializationPending !== true) ||
                entry.startupState?.status !== startup.status ||
                entry.startupState.operationId !== p.operationId
              ) {
                return null;
              }
              const { initializationPending: _pending, ...next } = entry;
              const failedStartup = {
                kind: "managed-worktree" as const,
                status: "failed" as const,
                operationId: entry.startupState.operationId,
                stage: entry.startupState.stage,
                startedAt: entry.startupState.startedAt,
                updatedAt,
                error: startupCompleted
                  ? "Gateway restarted before the initial message started. Send it again to continue in the prepared worktree."
                  : "Gateway restarted during worktree setup. Continue here or start a new session.",
                retryable: false,
                ...(entry.startupState.output ? { output: entry.startupState.output } : {}),
                ...(entry.startupState.initialTurn
                  ? { initialTurn: entry.startupState.initialTurn }
                  : {}),
              };
              return {
                ...next,
                startupState:
                  p.action === "cancel" && !startupCompleted
                    ? {
                        ...entry.startupState,
                        status: "cancelled",
                        updatedAt,
                        result:
                          "Worktree setup was cancelled after the Gateway restarted. The initial message was not sent.",
                      }
                    : failedStartup,
              };
            },
            { preserveActivity: true, replaceEntry: true },
          );
        },
      });
      if (recovered) {
        emitSessionsChanged(context, {
          sessionKey: current.canonicalKey,
          agentId: requestedAgent.agentId,
          reason: "create",
        });
        if (p.action === "work-local" || startupCompleted) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.UNAVAILABLE,
              startupCompleted
                ? "Gateway restarted before the initial message started. Send it again to continue in the prepared worktree."
                : "Gateway restarted during worktree setup. Send the initial message again to continue in this session.",
            ),
          );
          return;
        }
        respond(true, { ok: true });
        return;
      }
    }
    if (resolution !== "resolved") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "session startup is no longer active"),
      );
      return;
    }
    respond(true, { ok: true });
  };
