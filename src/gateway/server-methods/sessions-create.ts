// Session creation, initial turns, and managed-worktree provisioning.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { err, ok as resultOk } from "@openclaw/normalization-core/result";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  ErrorCodes,
  errorShape,
  missingScopeErrorShape,
  type SessionStartupStage,
  type SessionStartupState,
  validateSessionsCreateParams,
  validateSessionsStartupResolveParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { insideGitCheckout } from "../../agents/worktrees/git.js";
import { slugifyWorktreeTitle } from "../../agents/worktrees/name.js";
import { managedWorktrees, WorktreeRepositoryError } from "../../agents/worktrees/service.js";
import { resolveAgentMainSessionKey } from "../../config/sessions/main-session.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { sessionEntryForkedFromParent } from "../../config/sessions/session-entry-lineage.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  ProjectCheckoutError,
  resolveProjectCheckout,
  resolveProjectDirectory,
  resolveProjectRegistry,
} from "../../projects/project-registry.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { prepareWorktreeSessionTitle } from "../dashboard-session-title.js";
import { ADMIN_SCOPE, authorizeOperatorScopesForRequiredScope } from "../method-scopes.js";
import {
  buildDashboardSessionKey,
  createGatewaySession,
  resolveSessionCreateModelSelection as resolveCreateTitleEntry,
} from "../session-create-service.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "../session-request-agent.js";
import {
  registerSessionStartupOperation,
  resolveSessionStartupOperation,
} from "../session-startup-operations.js";
import { resolveSessionStoreAgentId } from "../session-store-key.js";
import { readSessionMessageCountAsync } from "../session-transcript-readers.js";
import {
  loadGatewaySessionEntryReadOnly,
  resolveGatewaySessionStoreTarget,
} from "../session-utils.js";
import { createAgentRuntimeAuthorityGuard } from "./agent-runtime-authority.js";
import { handleDirectExternalChatSend } from "./chat-send-external-entry.js";
import { chatHandlers } from "./chat.js";
import { resolveRegisteredCatalogCreateTarget } from "./session-catalog.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { registerCreatedSessionCategory } from "./session-create-category.js";
import {
  resolveSessionCreateInitialTurn,
  shouldAttachPendingMessageSeq,
} from "./session-create-initial-turn.js";
import { prepareSessionCreateFilesystemRoot } from "./session-create-root.js";
import { resolveOperatorSessionCreation } from "./session-creation-provenance.js";
import { sessionLog } from "./sessions-shared.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";
import { resolveWorkspacePathContainment } from "./workspace-path-containment.js";

export const sessionCreateHandlers: GatewayRequestHandlers = {
  "sessions.create": async ({
    req,
    params,
    respond,
    context,
    client,
    isWebchatConnect,
    sessionMutationAuthorization,
  }) => {
    if (!assertValidParams(params, validateSessionsCreateParams, "sessions.create", respond)) {
      return;
    }
    const p = params;
    const parentSessionKey = normalizeOptionalString(p.parentSessionKey);
    const requestedModel = normalizeOptionalString(p.model);
    const cfg = context.getRuntimeConfig();
    const authority = createAgentRuntimeAuthorityGuard(client, context, respond);
    const commitGuard =
      authority.commitGuard || sessionMutationAuthorization
        ? () => {
            authority.commitGuard?.();
            sessionMutationAuthorization?.assertCurrent();
          }
        : undefined;
    const catalogId = normalizeOptionalString(p.catalogId);
    const catalogConflict = p.model ? "model" : p.key ? "key" : undefined;
    if (catalogId && catalogConflict) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `sessions.create catalogId cannot include ${catalogConflict}`,
        ),
      );
      return;
    }
    const explicitlyRequestedKey = normalizeOptionalString(p.key);
    const explicitlyRequestedAgentId = normalizeOptionalString(p.agentId);
    // An omitted key means the selected agent's main alias, not the compatibility owner's alias.
    const agentSelectionKey =
      explicitlyRequestedKey ??
      (explicitlyRequestedAgentId
        ? `agent:${normalizeAgentId(explicitlyRequestedAgentId)}:main`
        : "main");
    const explicitlyRequestedAgent = resolveRequestedGlobalAgentId(
      cfg,
      agentSelectionKey,
      p.agentId ?? parseAgentSessionKey(explicitlyRequestedKey)?.agentId,
    );
    if (!explicitlyRequestedAgent.ok) {
      respond(false, undefined, explicitlyRequestedAgent.error);
      return;
    }
    const catalogRequestedKey = normalizeOptionalString(p.key) ?? "global";
    const catalogAgentId = catalogId
      ? normalizeAgentId(
          parseAgentSessionKey(catalogRequestedKey)?.agentId ?? explicitlyRequestedAgent.agentId,
        )
      : undefined;
    const catalogTarget =
      catalogId && catalogAgentId
        ? resolveRegisteredCatalogCreateTarget(catalogId, catalogAgentId, cfg)
        : undefined;
    if (catalogTarget && !catalogTarget.ok) {
      respond(
        false,
        undefined,
        errorShape(
          catalogTarget.unknownCatalog ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
          catalogTarget.message,
        ),
      );
      return;
    }
    const initialTurn = resolveSessionCreateInitialTurn(p);
    if (!initialTurn) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "sessions.create attachments require usable content",
        ),
      );
      return;
    }
    const {
      attachments: initialAttachments,
      hasInitialTurn,
      message: initialMessage,
    } = initialTurn;
    let requestedCwd = normalizeOptionalString(p.cwd);
    const requestedExecNode = normalizeOptionalString(p.execNode);
    const requestedProjectId = normalizeOptionalString(p.projectId);
    if (requestedProjectId && (requestedCwd || requestedExecNode)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "sessions.create projectId cannot be combined with cwd or execNode",
        ),
      );
      return;
    }
    // Agent tools expand `~` before RPC; the Gateway contract stays absolute-only.
    // Remote nodes may use Windows paths; local cwd must match the Gateway host.
    const cwdIsAbsolute =
      !requestedCwd ||
      (requestedExecNode
        ? path.isAbsolute(requestedCwd) || path.win32.isAbsolute(requestedCwd)
        : path.isAbsolute(requestedCwd));
    if (!cwdIsAbsolute) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "sessions.create cwd must be absolute"),
      );
      return;
    }
    const clientScopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
    if (p.permissionMode === "full" && client !== null && !clientScopes.includes(ADMIN_SCOPE)) {
      respond(
        false,
        undefined,
        missingScopeErrorShape({ missingScope: ADMIN_SCOPE, requiredScopes: [ADMIN_SCOPE] }),
      );
      return;
    }
    if (requestedCwd && !requestedExecNode && !clientScopes.includes(ADMIN_SCOPE)) {
      const containment = await resolveWorkspacePathContainment(requestedCwd, cfg);
      if (!containment) {
        respond(
          false,
          undefined,
          missingScopeErrorShape({
            missingScope: ADMIN_SCOPE,
            requiredScopes: [ADMIN_SCOPE],
          }),
        );
        return;
      }
      requestedCwd = containment.path;
    }
    if (requestedExecNode && p.worktree === true) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "sessions.create worktree cannot target execNode"),
      );
      return;
    }
    const requestedWorktreeBaseRef = normalizeOptionalString(p.worktreeBaseRef);
    const requestedWorktreeName = normalizeOptionalString(p.worktreeName);
    if ((requestedWorktreeBaseRef || requestedWorktreeName) && p.worktree !== true) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "sessions.create worktreeBaseRef/worktreeName require worktree=true",
        ),
      );
      return;
    }
    const explicitSessionLabel = normalizeOptionalString(p.label);
    const titleAgentId = explicitlyRequestedAgent.agentId;
    const shouldPrepareWorktreeTitle =
      p.worktree === true && !requestedWorktreeName && !explicitSessionLabel;
    const deferWorktreeTitle =
      shouldPrepareWorktreeTitle && Boolean(parentSessionKey) && !catalogTarget && !requestedModel;
    const worktreeTitleParams = shouldPrepareWorktreeTitle
      ? {
          cfg,
          agentId: titleAgentId,
          userMessage: initialMessage ?? "",
          attachments: initialAttachments,
          onError: (error: unknown) =>
            sessionLog.warn(`worktree title failed: ${formatErrorMessage(error)}`),
        }
      : undefined;
    // Known routes start before repository resolution; inherited routes wait for parent validation.
    let worktreeTitle =
      worktreeTitleParams && !deferWorktreeTitle
        ? prepareWorktreeSessionTitle({
            ...worktreeTitleParams,
            entry: resolveCreateTitleEntry(cfg, titleAgentId, catalogTarget?.target ?? p.model),
          })
        : undefined;
    let projectRoot: string | undefined;
    if (requestedProjectId) {
      const project = resolveProjectRegistry(cfg, requestedProjectId);
      if (!project) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unknown project id: ${requestedProjectId}`),
        );
        return;
      }
      try {
        const checkout =
          p.worktree === true ? await resolveProjectCheckout(project.repoRoot) : undefined;
        projectRoot = checkout?.path ?? (await resolveProjectDirectory(project.repoRoot));
        if (checkout && project.source !== "workspace" && checkout.path !== checkout.repoRoot) {
          throw new ProjectCheckoutError(`project root is no longer a git checkout`);
        }
      } catch (error) {
        const detail =
          error instanceof ProjectCheckoutError ? error.message : formatErrorMessage(error);
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            `project ${requestedProjectId} is unavailable (${detail}); update the agent workspace path or re-register the project`,
          ),
        );
        return;
      }
    }
    let sessionKey = p.key;
    let sessionAgentId = catalogAgentId ?? explicitlyRequestedAgent.agentId;
    let sessionWorktree: Awaited<ReturnType<typeof managedWorktrees.create>> | undefined;
    const sessionExecCwd = requestedExecNode ? requestedCwd : undefined;
    let sessionCwd = requestedExecNode ? undefined : (projectRoot ?? requestedCwd);
    let startupSourceCwd: string | undefined;
    let startupSourceRoot: string | undefined;
    let prepareLifecycle: Parameters<typeof createGatewaySession>[0]["prepareLifecycle"];
    let reportStartupStage: ((stage: SessionStartupStage) => Promise<void>) | undefined;
    let reportStartupOutput: ((chunk: Buffer) => void) | undefined;
    let startupControl: ReturnType<typeof registerSessionStartupOperation> | undefined;
    let prepareCommitGuard = commitGuard;
    let startupOperationId: string | undefined;
    const startupStartedAt = Date.now();
    const preparedRoot = prepareSessionCreateFilesystemRoot({
      cfg,
      enforceSandboxContainment: Boolean(
        sessionCwd && !requestedExecNode && (requestedProjectId || p.worktree !== true),
      ),
      requestedExecNode,
      requestedProjectId,
      sessionCwd,
      sessionKey,
      targetAgentId: sessionAgentId,
    });
    if (!preparedRoot.ok) {
      respond(false, undefined, preparedRoot.error);
      return;
    }
    sessionCwd = preparedRoot.value.sessionCwd;
    const sessionRoot = preparedRoot.value.sessionRoot;
    if (p.worktree === true) {
      // Workspace-contained cwd and registry-authorized projects stay at operator.write;
      // arbitrary host paths still require operator.admin before reaching this block.
      const explicitKey = explicitlyRequestedKey;
      const agentId = explicitlyRequestedAgent.agentId;
      let targetKey = explicitKey;
      let preservesUnspecifiedKey = false;
      if (
        !targetKey &&
        parentSessionKey &&
        p.emitCommandHooks === true &&
        !hasInitialTurn &&
        cfg.session?.dmScope === "main"
      ) {
        const parentRequestedAgent = resolveRequestedGlobalAgentId(cfg, parentSessionKey, agentId);
        if (!parentRequestedAgent.ok) {
          respond(false, undefined, parentRequestedAgent.error);
          return;
        }
        const parent = loadGatewaySessionEntryReadOnly(parentSessionKey, {
          agentId: parentRequestedAgent.agentId,
        });
        const parentAgentId = parentRequestedAgent.agentId;
        if (
          parent.entry?.sessionId &&
          parent.canonicalKey === resolveAgentMainSessionKey({ cfg, agentId: parentAgentId })
        ) {
          targetKey = parent.canonicalKey;
          preservesUnspecifiedKey = true;
        }
      }
      targetKey ??= buildDashboardSessionKey(agentId);
      const target = resolveGatewaySessionStoreTarget({ cfg, key: targetKey, agentId });
      sessionKey = preservesUnspecifiedKey ? undefined : targetKey;
      sessionAgentId = target.agentId;
      if (
        hasInitialTurn &&
        !sessionMutationAuthorization &&
        !loadGatewaySessionEntryReadOnly(target.canonicalKey, { agentId: target.agentId }).entry
      ) {
        startupOperationId = randomUUID();
      }
      const workspace =
        projectRoot ?? requestedCwd ?? resolveAgentWorkspaceDir(cfg, target.agentId);
      // Subdirectory workspaces are valid: the worktree service resolves the repo root
      // via git discovery, so the preflight must accept ancestor .git entries too.
      if (!insideGitCheckout(workspace)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "agent workspace is not a git checkout"),
        );
        return;
      }
      let requestedRepository: Awaited<ReturnType<typeof managedWorktrees.resolveRepositoryPaths>>;
      try {
        requestedRepository = await managedWorktrees.resolveRepositoryPaths(workspace);
        startupSourceCwd = fs.realpathSync(workspace);
        startupSourceRoot = requestedRepository.canonicalRoot;
      } catch (error) {
        if (error instanceof WorktreeRepositoryError) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, "agent workspace is not a git checkout"),
          );
          return;
        }
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
        return;
      }

      const scopes = Array.isArray(client?.connect.scopes) ? client.connect.scopes : [];
      prepareLifecycle = async (lifecycleTarget) => {
        try {
          if (deferWorktreeTitle && worktreeTitleParams) {
            worktreeTitle = prepareWorktreeSessionTitle({
              ...worktreeTitleParams,
              entry: lifecycleTarget.titleModelSelection,
            });
          }
          const boundId = normalizeOptionalString(lifecycleTarget.entry?.worktree?.id);
          let existing = boundId ? managedWorktrees.findLiveById(boundId) : undefined;
          if (
            existing &&
            (existing.ownerKind !== "session" || existing.ownerId !== lifecycleTarget.key)
          ) {
            return err(
              errorShape(ErrorCodes.UNAVAILABLE, "session worktree binding has a different owner"),
            );
          }
          existing ??= managedWorktrees.findLiveByOwner("session", lifecycleTarget.key);
          let existingDirectory = false;
          if (existing) {
            try {
              existingDirectory = fs.lstatSync(existing.path).isDirectory();
            } catch {
              // Missing registry targets are replaced by create() under its owner lease.
            }
          }
          let provisioned = false;
          if (existing && existingDirectory) {
            if (existing.repoRoot !== requestedRepository.canonicalRoot) {
              return err(
                errorShape(
                  ErrorCodes.INVALID_REQUEST,
                  "session worktree belongs to a different repository",
                ),
              );
            }
            if (
              (requestedWorktreeName && existing.name !== requestedWorktreeName) ||
              requestedWorktreeBaseRef
            ) {
              return err(
                errorShape(
                  ErrorCodes.INVALID_REQUEST,
                  `session is already bound to worktree ${existing.name} (${existing.branch})`,
                ),
              );
            }
            sessionWorktree = existing;
          } else {
            const generatedTitle = await worktreeTitle?.generated;
            sessionWorktree = await managedWorktrees.create({
              repoRoot: workspace,
              ownerKind: "session",
              ownerId: lifecycleTarget.key,
              name: requestedWorktreeName,
              suggestedName: slugifyWorktreeTitle(
                explicitSessionLabel ?? generatedTitle ?? worktreeTitle?.source ?? "",
              ),
              baseRef: requestedWorktreeBaseRef,
              // Checkout hooks and .openclaw/worktree-setup.sh run repo code; keep them
              // admin-only so this write-scoped path cannot execute gated repo scripts.
              runSetupScript: scopes.includes(ADMIN_SCOPE),
              onStage: async (stage) => {
                await reportStartupStage?.(stage);
              },
              onOutput: (chunk) => reportStartupOutput?.(chunk),
              ...(startupControl?.signal ? { signal: startupControl.signal } : {}),
              ...(prepareCommitGuard ? { commitGuard: prepareCommitGuard } : {}),
            });
            provisioned = true;
          }
          // Nested workspaces run from the matching subdirectory inside the worktree.
          sessionCwd = sessionWorktree.path;
          try {
            const relative = path.relative(
              requestedRepository.sourceRoot,
              fs.realpathSync(workspace),
            );
            if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
              sessionCwd = path.join(sessionWorktree.path, relative);
              fs.mkdirSync(sessionCwd, { recursive: true });
            }
          } catch {
            sessionCwd = sessionWorktree.path;
          }
          const preparedWorktree = sessionWorktree;
          const preparedSessionRoot = fs.realpathSync(preparedWorktree.path);
          prepareCommitGuard?.();
          return resultOk({
            spawnedCwd: sessionCwd,
            sessionRoot: preparedSessionRoot,
            worktree: {
              id: preparedWorktree.id,
              branch: preparedWorktree.branch,
              repoRoot: preparedWorktree.repoRoot,
              canonicalWorkspaceDir: workspace,
            },
            ...(provisioned
              ? {
                  rollback: async () => {
                    await managedWorktrees.remove({
                      id: preparedWorktree.id,
                      reason: "session-create-failed",
                      allowSnapshotLoss: true,
                    });
                  },
                }
              : {}),
          });
        } catch (error) {
          if (error instanceof TypeError && !authority.hasActive()) {
            throw error;
          }
          if (error instanceof WorktreeRepositoryError) {
            return err(
              errorShape(ErrorCodes.INVALID_REQUEST, "agent workspace is not a git checkout"),
            );
          }
          return err(errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
        }
      };
    }
    let runPayload: Record<string, unknown> | undefined;
    let runError: unknown;
    let runMeta: Record<string, unknown> | undefined;
    let messageSeq: number | undefined;
    const sessionCreation = resolveOperatorSessionCreation(client, { allowTrustedHint: true });
    const spawnRequesterSessionKey =
      sessionCreation.via === "spawn"
        ? normalizeOptionalString(sessionCreation.requesterSessionKey)
        : undefined;
    if (sessionCreation.inheritedToolPolicy && parentSessionKey !== spawnRequesterSessionKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "spawn parent must match the trusted agent caller"),
      );
      return;
    }
    const allowExistingModelSelection = authorizeOperatorScopesForRequiredScope(
      ADMIN_SCOPE,
      clientScopes,
    ).allowed;
    const modelCatalogAgentId = sessionAgentId;
    if (!authority.ensureActive()) {
      return;
    }
    const sessionStartupState:
      | Extract<SessionStartupState, { status: "initializing" }>
      | undefined = startupOperationId
      ? {
          kind: "managed-worktree",
          status: "initializing",
          operationId: startupOperationId,
          stage: "queued",
          startedAt: startupStartedAt,
          updatedAt: startupStartedAt,
          ...(hasInitialTurn
            ? {
                initialTurn: {
                  ...(initialMessage ? { message: initialMessage } : {}),
                  ...(initialAttachments ? { attachments: initialAttachments } : {}),
                },
              }
            : {}),
        }
      : undefined;
    const created = await createGatewaySession({
      cfg,
      key: sessionKey,
      agentId: sessionAgentId,
      label: p.label,
      category: p.category,
      ...(catalogTarget ? { catalogTarget: catalogTarget.target } : { model: requestedModel }),
      contextWindow: p.contextWindow,
      thinkingLevel: p.thinkingLevel,
      projectId: requestedProjectId,
      incognito: p.incognito,
      ...(client?.connect ? { requestingOperatorScopes: clientScopes } : {}),
      visibility: p.visibility,
      allowExistingModelSelection,
      parentSessionKey,
      spawnDepth: p.spawnDepth,
      spawnToolPolicy:
        sessionCreation.via === "spawn" && sessionCreation.inheritedToolPolicy
          ? {
              ...sessionCreation.inheritedToolPolicy,
              ...(sessionCreation.completionOwnerSessionKey
                ? { completionOwnerSessionKey: sessionCreation.completionOwnerSessionKey }
                : {}),
            }
          : undefined,
      spawnedCwd: p.worktree === true ? undefined : sessionCwd,
      sessionRoot: p.worktree === true ? undefined : sessionRoot,
      permissionMode: p.permissionMode ?? (p.worktree === true ? "workspace" : undefined),
      prepareLifecycle: startupOperationId ? undefined : prepareLifecycle,
      ...(sessionStartupState ? { startupState: sessionStartupState } : {}),
      onLifecycleCleanupError: (error) => {
        sessionLog.warn(
          `failed to finalize session worktree lifecycle: ${formatErrorMessage(error)}`,
        );
      },
      execNode: requestedExecNode,
      execCwd: sessionExecCwd,
      clearExecBinding: !requestedExecNode,
      // A plain New Chat with no cwd must not inherit the prior session cwd.
      clearSpawnedCwd: p.worktree !== true && !sessionCwd,
      fork: p.fork,
      forkFrom: p.forkFrom,
      succeedsParent: p.succeedsParent,
      emitCommandHooks: p.emitCommandHooks,
      resetMainWhenUnspecified: !hasInitialTurn,
      commandSource: "webchat",
      creation: sessionCreation,
      authorizedPluginId: normalizeOptionalString(client?.internal?.pluginRuntimeOwnerId),
      armSessionDiffBaselineCapture: true,
      loadGatewayModelCatalog: () =>
        context.loadGatewayModelCatalog({ agentId: modelCatalogAgentId }),
      ...(commitGuard ? { commitGuard } : {}),
      afterCreate: startupOperationId
        ? undefined
        : async ({ key, agentId, entry, storePath }) => {
            if (!authority.hasActive()) {
              return;
            }
            if (await worktreeTitle?.persist(agentId, entry, key, storePath)) {
              emitSessionsChanged(context, { sessionKey: key, agentId, reason: "chat.title" });
            }
            if (hasInitialTurn) {
              if (!authority.hasActive()) {
                return;
              }
              messageSeq =
                (await readSessionMessageCountAsync({
                  agentId,
                  sessionEntry: entry,
                  sessionId: entry.sessionId,
                  sessionKey: key,
                  storePath,
                })) + 1;
              await expectDefined(
                chatHandlers["chat.send"],
                "chat.send handler",
              )({
                req,
                params: {
                  sessionKey: key,
                  agentId,
                  message: initialMessage ?? "",
                  idempotencyKey: randomUUID(),
                  ...(initialAttachments ? { attachments: initialAttachments } : {}),
                },
                respond: (ok, payload, error, meta) => {
                  if (ok && payload && typeof payload === "object") {
                    runPayload = payload as Record<string, unknown>;
                  } else {
                    runError = error;
                  }
                  runMeta = meta;
                },
                context,
                client,
                isWebchatConnect,
              });
            }
          },
    }).catch((error: unknown) => authority.handleClosedError(error));
    if (!created) {
      return;
    }
    if (!created.ok) {
      respond(false, undefined, created.error);
      return;
    }
    registerCreatedSessionCategory(normalizeOptionalString(p.category), context);
    let startupAccepted = false;
    if (startupOperationId && prepareLifecycle) {
      const createdStartupEntry = created.entry;
      const startupStorePath = resolveGatewaySessionStoreTarget({
        cfg,
        key: created.key,
        agentId: created.agentId,
      }).storePath;
      startupControl = registerSessionStartupOperation({
        key: created.key,
        lifecycleRevision: createdStartupEntry.lifecycleRevision,
        operationId: startupOperationId,
        sessionId: createdStartupEntry.sessionId,
      });
      const assertStartupLifecycleOwner = () => {
        const entry = loadGatewaySessionEntryReadOnly(created.key, {
          agentId: created.agentId,
        }).entry;
        if (
          entry?.sessionId !== createdStartupEntry.sessionId ||
          entry.lifecycleRevision !== createdStartupEntry.lifecycleRevision ||
          entry.startupState?.operationId !== startupOperationId
        ) {
          throw new Error("session startup no longer owns the current lifecycle");
        }
      };
      const startupEntryIsCurrent = () => {
        startupControl?.signal.throwIfAborted();
        assertStartupLifecycleOwner();
      };
      prepareCommitGuard = startupEntryIsCurrent;
      const updateStartup = async (patch: Partial<SessionStartupState>) => {
        const updated = await patchSessionEntryCore(
          {
            agentId: created.agentId,
            sessionKey: created.key,
            storePath: startupStorePath,
          },
          (entry) => {
            if (
              entry.sessionId !== createdStartupEntry.sessionId ||
              entry.lifecycleRevision !== createdStartupEntry.lifecycleRevision ||
              entry.startupState?.operationId !== startupOperationId
            ) {
              return null;
            }
            return { startupState: { ...entry.startupState, ...patch } as SessionStartupState };
          },
          { preserveActivity: true },
        );
        if (updated?.startupState?.operationId === startupOperationId) {
          emitSessionsChanged(context, {
            sessionKey: created.key,
            agentId: created.agentId,
            reason: "create",
          });
          return true;
        }
        return false;
      };
      let startupOutput = createdStartupEntry.startupState?.output ?? "";
      let startupUpdateQueue = Promise.resolve(true);
      const queueStartupUpdate = (patch: Partial<SessionStartupState>) => {
        startupUpdateQueue = startupUpdateQueue
          .catch(() => false)
          .then(async () => await updateStartup(patch));
        return startupUpdateQueue;
      };
      reportStartupStage = async (stage) => {
        if (!(await queueStartupUpdate({ stage, updatedAt: Date.now() }))) {
          throw new Error("session startup no longer owns the current lifecycle");
        }
      };
      reportStartupOutput = (chunk) => {
        startupOutput = truncateUtf16Safe(`${startupOutput}${chunk.toString("utf8")}`, 16_384);
        void queueStartupUpdate({ output: startupOutput, updatedAt: Date.now() });
      };
      respond(
        true,
        {
          ok: true,
          key: created.key,
          sessionId: created.entry.sessionId,
          entry: created.entry,
          resolved: created.resolved,
          runStarted: false,
          startupState: created.entry.startupState,
        },
        undefined,
      );
      startupAccepted = true;
      emitSessionsChanged(context, {
        sessionKey: created.key,
        agentId: created.agentId,
        reason: "create",
      });

      const persistTerminalStartup = async (
        state: SessionStartupState,
        binding?: {
          sessionRoot?: string;
          spawnedCwd?: string;
          worktree?: typeof created.entry.worktree;
        },
      ) =>
        await patchSessionEntryCore(
          {
            agentId: created.agentId,
            sessionKey: created.key,
            storePath: startupStorePath,
          },
          (entry) => {
            if (
              entry.sessionId !== createdStartupEntry.sessionId ||
              entry.lifecycleRevision !== createdStartupEntry.lifecycleRevision ||
              entry.startupState?.operationId !== startupOperationId
            ) {
              return null;
            }
            const { initializationPending: _pending, ...next } = entry;
            return { ...next, ...binding, startupState: state };
          },
          { preserveActivity: true, replaceEntry: true },
        );

      const dispatchInitialTurn = async (): Promise<void> => {
        if (!hasInitialTurn) {
          const cleared = await patchSessionEntryCore(
            {
              agentId: created.agentId,
              sessionKey: created.key,
              storePath: startupStorePath,
            },
            (entry) => {
              if (
                entry.sessionId !== createdStartupEntry.sessionId ||
                entry.lifecycleRevision !== createdStartupEntry.lifecycleRevision ||
                entry.startupState?.operationId !== startupOperationId
              ) {
                return null;
              }
              const { startupState: _startupState, ...next } = entry;
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
        let dispatchSessionIdentity: { lifecycleRevision?: string; sessionId: string } | undefined;
        let releaseDispatchSettlement: (() => void) | undefined;
        const startupStateCleared = new Promise<void>((resolve) => {
          releaseDispatchSettlement = resolve;
        });
        const persistDispatchFailure = async (error: unknown) => {
          const failedAt = Date.now();
          const updated = await patchSessionEntryCore(
            {
              agentId: created.agentId,
              sessionKey: created.key,
              storePath: startupStorePath,
            },
            (entry) => {
              if (
                !dispatchSessionIdentity ||
                entry.sessionId !== dispatchSessionIdentity.sessionId ||
                entry.lifecycleRevision !== dispatchSessionIdentity.lifecycleRevision ||
                (entry.startupState !== undefined &&
                  entry.startupState.operationId !== startupOperationId)
              ) {
                return null;
              }
              const { initializationPending: _pending, ...next } = entry;
              return {
                ...next,
                startupState: {
                  ...createdStartupEntry.startupState,
                  kind: "managed-worktree",
                  status: "failed",
                  operationId: startupOperationId,
                  stage: "running-setup",
                  startedAt: startupStartedAt,
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
              assertStartupLifecycleOwner();
              return true;
            } catch {
              return false;
            }
          },
          async (outcome) => {
            await startupStateCleared;
            if (!outcome.ok) {
              await persistDispatchFailure(outcome.error);
            }
          },
        );
        const admittedEntry = loadGatewaySessionEntryReadOnly(created.key, {
          agentId: created.agentId,
        }).entry;
        if (!admittedEntry || admittedEntry.sessionId !== createdStartupEntry.sessionId) {
          throw new Error("initial turn no longer owns the created session");
        }
        dispatchSessionIdentity = {
          lifecycleRevision: admittedEntry.lifecycleRevision,
          sessionId: admittedEntry.sessionId,
        };
        if (!accepted) {
          await persistDispatchFailure(dispatchError ?? "dispatch rejected");
          return;
        }
        let cleared: Awaited<ReturnType<typeof patchSessionEntryCore>>;
        try {
          cleared = await patchSessionEntryCore(
            {
              agentId: created.agentId,
              sessionKey: created.key,
              storePath: startupStorePath,
            },
            (entry) => {
              if (
                entry.sessionId !== dispatchSessionIdentity.sessionId ||
                entry.lifecycleRevision !== dispatchSessionIdentity.lifecycleRevision
              ) {
                return null;
              }
              if (entry.startupState === undefined) {
                return null;
              }
              if (entry.startupState.operationId !== startupOperationId) {
                return null;
              }
              const { startupState: _startupState, ...next } = entry;
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

      void (async () => {
        let prepared: Awaited<ReturnType<NonNullable<typeof prepareLifecycle>>> | undefined;
        try {
          await reportStartupStage?.("preparing");
          prepared = await prepareLifecycle({
            agentId: created.agentId,
            entry: createdStartupEntry,
            key: created.key,
            storePath: startupStorePath,
            titleModelSelection: resolveCreateTitleEntry(
              cfg,
              created.agentId,
              catalogTarget?.target ?? requestedModel,
              createdStartupEntry,
            ),
          });
          if (!prepared.ok) {
            throw new Error(prepared.error.message);
          }
          await startupUpdateQueue;
          startupEntryIsCurrent();
          const completedAt = Date.now();
          const completedState: SessionStartupState = {
            ...createdStartupEntry.startupState,
            kind: "managed-worktree",
            status: "completed",
            operationId: startupOperationId,
            stage: "running-setup",
            startedAt: startupStartedAt,
            updatedAt: completedAt,
            worktreePath: prepared.value.spawnedCwd ?? prepared.value.sessionRoot ?? "worktree",
            ...(startupOutput ? { output: startupOutput } : {}),
          };
          const finalized = await persistTerminalStartup(completedState, {
            spawnedCwd: prepared.value.spawnedCwd,
            sessionRoot: prepared.value.sessionRoot,
            worktree: prepared.value.worktree,
          });
          if (!finalized) {
            await prepared.value.rollback?.();
            return;
          }
          emitSessionsChanged(context, {
            sessionKey: created.key,
            agentId: created.agentId,
            reason: "create",
          });
          if (
            await worktreeTitle?.persist(created.agentId, finalized, created.key, startupStorePath)
          ) {
            emitSessionsChanged(context, {
              sessionKey: created.key,
              agentId: created.agentId,
              reason: "chat.title",
            });
          }
          await dispatchInitialTurn();
        } catch (error) {
          const current = loadGatewaySessionEntryReadOnly(created.key, {
            agentId: created.agentId,
          }).entry;
          const currentState = current?.startupState;
          if (
            current?.sessionId !== createdStartupEntry.sessionId ||
            current.lifecycleRevision !== createdStartupEntry.lifecycleRevision ||
            currentState?.operationId !== startupOperationId
          ) {
            return;
          }
          const resolution = startupControl?.resolution();
          const updatedAt = Date.now();
          if (resolution === "cancel") {
            await persistTerminalStartup({
              ...currentState,
              status: "cancelled",
              updatedAt,
              result: "Worktree setup cancelled. The initial message was not sent.",
            });
            return;
          }
          if (resolution === "work-local") {
            const local = await persistTerminalStartup(
              {
                ...currentState,
                status: "local",
                updatedAt,
                result: "Continuing in the existing workspace.",
              },
              { spawnedCwd: startupSourceCwd, sessionRoot: startupSourceRoot },
            );
            if (local) {
              await dispatchInitialTurn();
            }
            return;
          }
          await persistTerminalStartup(
            {
              ...currentState,
              status: "failed",
              updatedAt,
              error: formatErrorMessage(error).slice(0, 512) || "Worktree setup failed",
              retryable: false,
            },
            { spawnedCwd: startupSourceCwd, sessionRoot: startupSourceRoot },
          );
        } finally {
          startupControl?.release();
          emitSessionsChanged(context, {
            sessionKey: created.key,
            agentId: created.agentId,
            reason: "create",
          });
        }
      })().catch((error: unknown) => {
        sessionLog.warn(`session startup lifecycle failed: ${formatErrorMessage(error)}`);
      });
    }
    if (created.postCommit.status === "failed") {
      runError = errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(created.postCommit.error));
    }
    const createdWorktree = sessionWorktree
      ? {
          id: sessionWorktree.id,
          path: sessionWorktree.path,
          branch: sessionWorktree.branch,
        }
      : undefined;
    const responseEntry = sessionEntryForkedFromParent(created.entry)
      ? { ...created.entry, forkedFromParent: true as const }
      : created.entry;
    if (created.resetExisting) {
      respond(
        true,
        {
          ok: true,
          key: created.key,
          sessionId: created.entry.sessionId,
          entry: responseEntry,
          resolved: created.resolved,
          runStarted: false,
          ...(createdWorktree ? { worktree: createdWorktree } : {}),
        },
        undefined,
      );
      emitSessionsChanged(context, {
        sessionKey: created.key,
        agentId: created.agentId,
        reason: "new",
      });
      return;
    }

    if (startupAccepted) {
      return;
    }

    const runStarted =
      runPayload !== undefined &&
      shouldAttachPendingMessageSeq({
        payload: runPayload,
        cached: runMeta?.cached === true,
      });

    respond(
      true,
      {
        ok: true,
        key: created.key,
        sessionId: created.entry.sessionId,
        entry: responseEntry,
        runStarted,
        ...(runPayload ? runPayload : {}),
        ...(runStarted && typeof messageSeq === "number" ? { messageSeq } : {}),
        ...(runError ? { runError } : {}),
        resolved: created.resolved,
        ...(createdWorktree ? { worktree: createdWorktree } : {}),
      },
      undefined,
    );
    emitSessionsChanged(context, {
      sessionKey: created.key,
      agentId: created.agentId,
      reason: "create",
    });
    if (runStarted) {
      emitSessionsChanged(context, {
        sessionKey: created.key,
        agentId: created.agentId,
        reason: "send",
      });
    }
  },
  "sessions.startup.resolve": async ({
    params,
    respond,
    context,
    sessionMutationAuthorization,
  }) => {
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
    const requestedAgent = resolveRequestedGlobalAgentId(cfg, p.key, undefined, {
      allowUnconfiguredExplicitAgent: true,
    });
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
      current.entry?.initializationPending !== true ||
      startup?.status !== "initializing" ||
      startup.operationId !== p.operationId
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "session startup is no longer active"),
      );
      return;
    }
    const resolution = resolveSessionStartupOperation({
      action: p.action,
      key: current.canonicalKey,
      lifecycleRevision: current.entry.lifecycleRevision,
      operationId: p.operationId,
      sessionId: current.entry.sessionId,
    });
    if (resolution === "missing") {
      const updatedAt = Date.now();
      const recovered = await patchSessionEntryCore(
        {
          agentId: requestedAgent.agentId,
          sessionKey: current.canonicalKey,
          storePath: current.storePath,
        },
        (entry) => {
          sessionMutationAuthorization?.assertCurrent();
          if (
            entry.sessionId !== current.entry?.sessionId ||
            entry.lifecycleRevision !== current.entry.lifecycleRevision ||
            entry.initializationPending !== true ||
            entry.startupState?.status !== "initializing" ||
            entry.startupState.operationId !== p.operationId
          ) {
            return null;
          }
          const { initializationPending: _pending, ...next } = entry;
          return {
            ...next,
            startupState:
              p.action === "cancel"
                ? {
                    ...entry.startupState,
                    status: "cancelled",
                    updatedAt,
                    result:
                      "Worktree setup was cancelled after the Gateway restarted. The initial message was not sent.",
                  }
                : {
                    ...entry.startupState,
                    status: "failed",
                    updatedAt,
                    error:
                      "Gateway restarted during worktree setup. Continue here or start a new session.",
                    retryable: false,
                  },
          };
        },
        { preserveActivity: true, replaceEntry: true },
      );
      if (recovered) {
        emitSessionsChanged(context, {
          sessionKey: current.canonicalKey,
          agentId: requestedAgent.agentId,
          reason: "create",
        });
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
  },
};
