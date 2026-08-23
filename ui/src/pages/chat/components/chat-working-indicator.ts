import { html, nothing } from "lit";
import type { SessionStartupState } from "../../../../../packages/gateway-protocol/src/index.js";
import "../../../components/elapsed-time.ts";
import type { ApplicationPlacementStartupStatus } from "../../../app/session-placement-startup.ts";
import "../../../components/working-phrase.ts";
import { icons } from "../../../components/icons.ts";
import { i18n, t } from "../../../i18n/index.ts";
import type { ChatItem } from "../../../lib/chat/chat-types.ts";
import { formatCompactTokenCount } from "../../../lib/format.ts";
import type { TurnRecap } from "../chat-progress.ts";
import type { ChatRunStartupPhase } from "../chat-run-startup.ts";
import { selectWorkingClawSurprise } from "./chat-working-indicator-surprise.ts";

// Almost every run uses the default loop; an alternate move fires once, then yields back to it.
const STARTUP_STATUS_LABEL_KEYS = {
  preparing_workspace: "chat.startupStatus.preparingWorkspace",
  provisioning_environment: "chat.startupStatus.provisioningEnvironment",
  preparing_context: "chat.startupStatus.preparingContext",
  starting_model: "chat.startupStatus.startingModel",
} as const satisfies Record<ChatRunStartupPhase, Parameters<typeof t>[0]>;
const TURN_RECAP_DURATION_UNITS = [
  { seconds: 86_400, unit: "day" },
  { seconds: 3_600, unit: "hour" },
  { seconds: 60, unit: "minute" },
  { seconds: 1, unit: "second" },
] as const;

function startupStatusLabel(phase: ChatRunStartupPhase): string {
  return t(STARTUP_STATUS_LABEL_KEYS[phase]);
}

function placementStartupStatusLabel(status: ApplicationPlacementStartupStatus): string {
  if (status.phase === "pending") {
    return t("newSession.starting");
  }
  return status.phase === "sending" || status.phase === "active"
    ? t("chat.composer.sendingMessage")
    : t("sessionsView.cloudWorkerPlacement", { state: status.phase });
}

export function renderPlacementStartupStatus(
  status: ApplicationPlacementStartupStatus | null | undefined,
  onRetry?: () => void,
) {
  if (!status) {
    return nothing;
  }
  if (status.phase === "failed") {
    return html`
      <div class="chat-error chat-cloud-startup-error" role="alert">
        <span class="chat-error__dot" aria-hidden="true"></span>
        <span class="chat-error__content"
          >${t("newSession.placementStartFailed", {
            error: status.error ?? t("newSession.createFailed"),
          })}</span
        >
        ${status.retryable && onRetry
          ? html`<button class="btn btn--sm" type="button" @click=${onRetry}>
              ${t("common.retry")}
            </button>`
          : nothing}
      </div>
    `;
  }
  return html`
    <div class="chat-working-indicator chat-cloud-startup" role="status" aria-live="polite">
      <div class="chat-bubble chat-reading-indicator" aria-hidden="true">${icons.claw}</div>
      <span class="chat-working-indicator__status">
        <span>${placementStartupStatusLabel(status)}</span>
        <openclaw-elapsed-time
          class="chat-working-indicator__elapsed"
          .startMs=${status.startedAt}
        ></openclaw-elapsed-time>
      </span>
    </div>
  `;
}

const WORKTREE_STAGE_LABEL_KEYS = {
  queued: "chat.worktreeStartup.queued",
  preparing: "chat.worktreeStartup.preparing",
  "fetching-base": "chat.worktreeStartup.fetchingBase",
  "checking-out": "chat.worktreeStartup.checkingOut",
  "provisioning-files": "chat.worktreeStartup.provisioningFiles",
  "running-setup": "chat.worktreeStartup.runningSetup",
} as const satisfies Record<SessionStartupState["stage"], Parameters<typeof t>[0]>;

function worktreeStartupLabel(status: SessionStartupState): string {
  if (status.status === "initializing") {
    return t(WORKTREE_STAGE_LABEL_KEYS[status.stage]);
  }
  if (status.status === "failed") {
    return t("chat.worktreeStartup.failed", { error: status.error });
  }
  if (status.status === "completed") {
    return t("chat.worktreeStartup.completed");
  }
  return status.result;
}

export function renderWorktreeStartupStatus(
  status: SessionStartupState | null | undefined,
  options: {
    defaultOpen?: boolean;
    onCancel?: () => void;
    onWorkLocal?: () => void;
  } = {},
) {
  if (!status) {
    return nothing;
  }
  const actionable = status.status === "initializing";
  const hasBody = Boolean(status.output) || actionable;
  const open =
    options.defaultOpen ?? (status.status === "initializing" || status.status === "failed");
  return html`
    <details class="chat-tool-msg-collapse chat-worktree-startup" ?open=${hasBody && open}>
      <summary
        class="chat-inline-disclosure chat-tool-msg-summary chat-tool-row ${status.status ===
        "failed"
          ? "chat-tool-msg-summary--error"
          : ""}"
        role="status"
      >
        <span class="chat-tool-msg-summary__icon">${icons.folder}</span>
        <span class="chat-tool-msg-summary__label">${worktreeStartupLabel(status)}</span>
        ${hasBody
          ? html`<span class="chat-inline-disclosure__chevron" aria-hidden="true"
              >${icons.chevronDown}</span
            >`
          : nothing}
      </summary>
      ${hasBody
        ? html`<div class="chat-tool-msg-body">
            ${status.output
              ? html`<div class="chat-worktree-startup__code"><pre>${status.output}</pre></div>`
              : nothing}
            ${actionable
              ? html`<div class="chat-worktree-startup__actions">
                  ${options.onCancel
                    ? html`<button
                        class="btn btn--sm btn--ghost"
                        type="button"
                        @click=${options.onCancel}
                      >
                        ${t("common.cancel")}
                      </button>`
                    : nothing}
                  ${options.onWorkLocal
                    ? html`<button
                        class="btn btn--sm btn--primary"
                        type="button"
                        @click=${options.onWorkLocal}
                      >
                        ${t("chat.worktreeStartup.workLocal")}
                      </button>`
                    : nothing}
                </div>`
              : nothing}
          </div>`
        : nothing}
    </details>
  `;
}

function formatTurnRecapDuration(ms: number): string {
  let remainingSeconds = Math.max(1, Math.round(ms / 1_000));
  const locale = i18n.getLocale();
  const parts: string[] = [];
  for (const { seconds, unit } of TURN_RECAP_DURATION_UNITS) {
    const value = Math.floor(remainingSeconds / seconds);
    if (value === 0) {
      continue;
    }
    parts.push(
      new Intl.NumberFormat(locale, {
        style: "unit",
        unit,
        unitDisplay: "long",
      }).format(value),
    );
    remainingSeconds -= value * seconds;
    if (parts.length === 2) {
      break;
    }
  }
  return new Intl.ListFormat(locale, { style: "long", type: "unit" }).format(parts);
}

// 0 is a valid count (command-only turns); only null/undefined means "unknown".
function outputTokensLabel(outputTokens: number): string {
  return outputTokens === 1
    ? t("chat.turnRecap.tokensOne")
    : t("chat.turnRecap.tokens", { count: formatCompactTokenCount(outputTokens) });
}

function renderLiveOutputTokens(outputTokens: number | null | undefined) {
  if (outputTokens === null || outputTokens === undefined) {
    return nothing;
  }
  return html`
    <span aria-hidden="true">·</span>
    <span class="chat-working-indicator__tokens">${outputTokensLabel(outputTokens)}</span>
  `;
}

export function renderChatWorkingIndicator(
  part: Extract<ChatItem, { kind: "reading-indicator" }>,
  options: {
    waitingApproval?: boolean;
    startupPhase?: ChatRunStartupPhase;
    outputTokens?: number | null;
    presentation?: "standalone" | "continuation";
  } = {},
) {
  const waitingApproval = options.waitingApproval === true;
  const continuation = options.presentation === "continuation";
  // Streaming tokens are the real liveness signal; the whimsical phrase only
  // covers the stretch before any usage data exists.
  const hasTokens = options.outputTokens !== null && options.outputTokens !== undefined;
  // The animated claw stays decorative; the text status exposes progress without
  // announcing every elapsed-time tick to screen readers.
  return html`
    <div
      class="chat-working-indicator ${continuation ? "chat-working-indicator--continuation" : ""}"
      role="status"
      aria-live="off"
    >
      ${continuation
        ? nothing
        : html`
            <div
              class="chat-bubble chat-reading-indicator ${selectWorkingClawSurprise(part.key, {
                eligible: !waitingApproval,
              })}"
              aria-hidden="true"
            >
              ${icons.claw}
            </div>
          `}
      <span class="chat-working-indicator__status">
        ${waitingApproval
          ? html`<span>${t("chat.waitingForApproval")}</span>`
          : options.startupPhase
            ? html`
                <span>${startupStatusLabel(options.startupPhase)}</span>
                <openclaw-elapsed-time
                  class="chat-working-indicator__elapsed"
                  .startMs=${part.startedAt}
                ></openclaw-elapsed-time>
                ${renderLiveOutputTokens(options.outputTokens)}
              `
            : html`
                <span class=${continuation ? "" : "sr-only"}>${t("common.working")}</span>
                <openclaw-elapsed-time
                  class="chat-working-indicator__elapsed"
                  .startMs=${part.startedAt}
                ></openclaw-elapsed-time>
                ${hasTokens
                  ? renderLiveOutputTokens(options.outputTokens)
                  : html`
                      <openclaw-working-phrase
                        aria-hidden="true"
                        .startMs=${part.startedAt}
                        .seed=${part.key}
                      ></openclaw-working-phrase>
                    `}
              `}
      </span>
    </div>
  `;
}

/** Post-turn recap row: once the run settles, the parked claw reports how
 * long the turn took (and its output tokens when the terminal patch carried
 * them). Sticky until the next run replaces it. */
export function renderTurnRecapRow(
  recap: TurnRecap,
  options: { presentation?: "standalone" | "continuation" } = {},
) {
  const continuation = options.presentation === "continuation";
  // Sub-second turns still read as one second; terminal recaps favor full words.
  const duration = formatTurnRecapDuration(recap.runtimeMs);
  const tokens =
    typeof recap.outputTokens === "number" ? outputTokensLabel(recap.outputTokens) : null;
  return html`
    <div
      class="chat-tasks-status chat-turn-recap ${continuation
        ? "chat-turn-recap--continuation"
        : ""}"
      role="status"
    >
      ${continuation
        ? nothing
        : html`<span class="chat-tasks-status__claw" aria-hidden="true">${icons.claw}</span>`}
      <span>${t("chat.turnRecap.doneIn", { duration })}</span>
      ${tokens === null
        ? nothing
        : html`
            <span class="chat-tasks-status__sep" aria-hidden="true">·</span>
            <span>${tokens}</span>
          `}
    </div>
  `;
}
