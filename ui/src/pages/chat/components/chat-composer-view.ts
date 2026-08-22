import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing, type TemplateResult } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { ref } from "lit/directives/ref.js";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { icons } from "../../../components/icons.ts";
import { renderSessionProgressCard } from "../../../components/session-progress-card.ts";
import { t } from "../../../i18n/index.ts";
import { detectTextDirection } from "../../../lib/text-direction.ts";
import type { ComposerDictationController } from "../composer-dictation.ts";
import { insertComposerDictation } from "../composer-dictation.ts";
import {
  handleChatAttachmentPaste,
  renderAttachmentPreview,
  renderChatAttachmentInputs,
} from "./chat-attachments.ts";
import type { ChatRunControlsProps } from "./chat-composer-controls.ts";
import { renderChatPrimaryActions } from "./chat-composer-controls.ts";
import { focusComposerFromChrome, paneDomId } from "./chat-composer-dom.ts";
import { renderChatGoal } from "./chat-composer-goal.ts";
import { renderChatComposerPlusMenu } from "./chat-composer-plus-menu.ts";
import { renderChatQueue } from "./chat-composer-queue.ts";
import {
  renderSkillDraftOverlay,
  renderSkillMenu,
  type SkillMenuHost,
} from "./chat-composer-skill-menu.ts";
import { renderSlashMenu } from "./chat-composer-slash-menu.ts";
import { commitComposerDraft } from "./chat-composer-state.ts";
import {
  renderCompactionIndicator,
  renderFallbackIndicator,
  type ComposerRunStatus,
} from "./chat-composer-status.ts";
import type { ChatComposerProps, ChatComposerState } from "./chat-composer-types.ts";
import { renderChatPermissionPicker } from "./chat-permission-picker.ts";
import {
  closeChatComposerPickerOnEscape,
  handleChatComposerDropdownShow,
  markPointerOpenedChatComposerDropdown,
  restorePointerOpenedChatComposerTrigger,
} from "./chat-picker-overlay.ts";
import type { createGatewayQuestionPanelProps } from "./chat-question-card.ts";
import { renderChatVoiceError, renderMicrophoneActivity } from "./chat-voice-activity.ts";

type ChatComposerViewContext = {
  props: ChatComposerProps;
  state: ChatComposerState;
  canCompose: boolean;
  showAbortableUi: boolean;
  activeSession: GatewaySessionRow | undefined;
  visibleDraft: string;
  contextNotice: TemplateResult | typeof nothing;
  composerControls: TemplateResult | typeof nothing;
  runStatusAnnouncement: string;
  requestUpdate: () => void;
  sendShortcut: "enter" | "modifier-enter";
  questionPanelProps: ReturnType<typeof createGatewayQuestionPanelProps> | null;
  showComposer: boolean;
  placeholder: string;
  handleKeyDown: (event: KeyboardEvent) => void;
  handleBeforeInput: (event: InputEvent) => void;
  handleInput: (event: InputEvent) => void;
  handleSelect: (event: Event) => void;
  draftKey: string;
  handleCompositionEnd: (event: CompositionEvent) => void;
  handleBlur: (event: FocusEvent) => void;
  dictation: ComposerDictationController | undefined;
  runControlsProps: ChatRunControlsProps;
  mirrorCameraPreview: boolean;
  slashMenuVisible: boolean;
  skillMenuVisible: boolean;
  skillMenuHost: SkillMenuHost;
  activeSlashMenuOptionId: string | null;
  activeSlashMenuOptionLabel: string;
  slashMenuListboxId: string;
  slashMenuAnnouncementId: string;
  composerRunStatus: ComposerRunStatus | null | undefined;
};

export function renderChatComposerView(context: ChatComposerViewContext) {
  const {
    props,
    state,
    canCompose,
    showAbortableUi,
    activeSession,
    visibleDraft,
    contextNotice,
    composerControls,
    runStatusAnnouncement,
    requestUpdate,
    sendShortcut,
    questionPanelProps,
    showComposer,
    placeholder,
    handleKeyDown,
    handleBeforeInput,
    handleInput,
    handleSelect,
    draftKey,
    handleCompositionEnd,
    handleBlur,
    dictation,
    runControlsProps,
    mirrorCameraPreview,
    slashMenuVisible,
    skillMenuVisible,
    skillMenuHost,
    activeSlashMenuOptionId,
    activeSlashMenuOptionLabel,
    slashMenuListboxId,
    slashMenuAnnouncementId,
    composerRunStatus,
  } = context;
  const disabledBanner = props.disabledBanner
    ? html`
        <div
          class="agent-chat__disabled-banner callout ${props.disabledBanner.tone === "neutral"
            ? "agent-chat__disabled-banner--neutral"
            : "info"} callout--action"
          role="status"
        >
          ${props.disabledBanner.icon
            ? html`<span
                class="agent-chat__disabled-banner-icon agent-chat__disabled-banner-icon--${props
                  .disabledBanner.icon}"
                aria-hidden="true"
                >${props.disabledBanner.icon === "archive"
                  ? icons.archive
                  : icons.alertTriangle}</span
              >`
            : nothing}
          <div class="callout__content">
            ${props.disabledBanner.title
              ? html`<div class="agent-chat__disabled-banner-title">
                  ${props.disabledBanner.title}
                </div>`
              : nothing}
            <div class="agent-chat__disabled-banner-detail">${props.disabledBanner.text}</div>
          </div>
          <button
            type="button"
            class="btn btn--sm ${props.disabledBanner.actionStyle ?? ""}"
            ?disabled=${Boolean(props.disabledBanner.disabledReason) || props.disabledBanner.busy}
            aria-busy=${props.disabledBanner.busy ? "true" : "false"}
            title=${props.disabledBanner.disabledReason ?? nothing}
            @click=${props.disabledBanner.onAction}
          >
            ${props.disabledBanner.busy
              ? html`<span class="btn__spinner" aria-hidden="true"></span>${props.disabledBanner
                    .busyLabel ?? props.disabledBanner.actionLabel}`
              : props.disabledBanner.actionLabel}
          </button>
          ${props.disabledBanner.kind === "composer-replacement" && showAbortableUi
            ? renderChatPrimaryActions(runControlsProps)
            : nothing}
        </div>
      `
    : nothing;
  const showComposerInput = showComposer && props.disabledBanner?.kind !== "composer-replacement";
  if (!props.capabilityMenu) {
    state.capabilityMenuView = "root";
  }
  const disabledReasonId = paneDomId(props.paneId, "disabled-reason");
  const voiceError = showComposerInput
    ? renderChatVoiceError({
        status: props.realtimeTalkCameraError ? "error" : props.realtimeTalkStatus,
        detail: props.realtimeTalkDetail,
        onDismissError: props.realtimeTalkCameraError
          ? undefined
          : props.onDismissRealtimeTalkError,
      })
    : nothing;
  const runError = props.runError
    ? html`
        <div class="agent-chat__composer-error agent-chat__run-error chat-run-error" role="alert">
          <span
            class="agent-chat__composer-error-icon chat-run-error__icon"
            aria-hidden="true"
            >${icons.alertTriangle}</span
          >
          <span class="agent-chat__composer-error-text chat-run-error__summary"
            >${props.runError.summary}</span
          >
        </div>
      `
    : nothing;
  const interruptedNotice =
    composerRunStatus?.phase === "interrupted"
      ? html`
          <div class="agent-chat__composer-error agent-chat__run-error chat-run-error" role="status">
            <span class="agent-chat__composer-error-icon chat-run-error__icon" aria-hidden="true"
              >${icons.stop}</span
            >
            <span class="agent-chat__composer-error-text chat-run-error__summary"
              >${t("chat.composer.runInterrupted")}</span
            >
          </div>
        `
      : nothing;
  const disabledNotice =
    showComposerInput && props.disabledReason
      ? html`
          <div id=${disabledReasonId} class="agent-chat__composer-notice" role="note">
            <span class="agent-chat__composer-notice-icon" aria-hidden="true"
              >${icons.shieldQuestion}</span
            >
            <span class="agent-chat__composer-error-text">${props.disabledReason}</span>
          </div>
        `
      : nothing;
  const composerAlerts =
    voiceError !== nothing ||
    runError !== nothing ||
    interruptedNotice !== nothing ||
    disabledNotice !== nothing
      ? html`<div
          class="agent-chat__composer-errors ${showComposerInput
            ? ""
            : "agent-chat__composer-errors--standalone"}"
          >${voiceError}${runError}${interruptedNotice}${disabledNotice}</div
        >`
      : nothing;
  const offlineHint =
    showComposerInput && props.offline
      ? html`<div class="agent-chat__offline-hint" role="status" aria-live="polite">
          ${props.queuedOutboxCount
            ? t("chat.composer.offlineQueuedHint", {
                count: String(props.queuedOutboxCount),
              })
            : t("chat.composer.offlineHint")}
        </div>`
      : nothing;
  const composerUnderlaps =
    showComposerInput && (composerAlerts !== nothing || offlineHint !== nothing)
      ? html`<div class="agent-chat__composer-underlaps">${composerAlerts}${offlineHint}</div>`
      : nothing;
  const skillDraftOverlay = renderSkillDraftOverlay(visibleDraft);
  // Dictation streams into the editor: the live partial previews at the spot
  // the commit will use (the selection captured at hold start), so the operator
  // reads their words landing in the draft rather than in a side status row.
  // The textarea is read-only for the whole capture, so the preview swap never
  // fights operator edits; release performs the real insert.
  const dictationPreviewDraft =
    dictation?.active && dictation.partial
      ? insertComposerDictation(
          visibleDraft,
          dictation.partial,
          state.dictationSelection?.start ?? visibleDraft.length,
          state.dictationSelection?.end ?? visibleDraft.length,
        ).value
      : visibleDraft;

  const queue = renderChatQueue({
    queue: props.queue,
    canAbort: showAbortableUi,
    onQueueRetry: props.connected && canCompose ? props.onQueueRetry : undefined,
    onQueueSteer: props.connected && canCompose ? props.onQueueSteer : undefined,
    // Reordering is local bookkeeping, so it stays available while offline —
    // exactly when a queue is long enough to need it.
    onQueueMove: props.onQueueMove,
    onQueueEdit: props.queuedEdit?.onEdit,
    onQueueEditChange: props.queuedEdit?.onEditChange,
    onQueueEditSubmit: props.queuedEdit?.onEditSubmit,
    onQueueEditCancel: props.queuedEdit?.onCancel,
    editingId: props.queuedEdit?.editingId ?? null,
    editingText: props.queuedEdit?.editingText,
    onQueueRemove: props.onQueueRemove,
  });
  const progressCard = props.progressCard
    ? html`<div class="agent-chat__progress-float">
        ${renderSessionProgressCard(props.progressCard, "composer", props.onDismissProgressCard)}
      </div>`
    : nothing;
  const goal = activeSession?.goal
    ? html`<div class="agent-chat__goal-float">
        ${renderChatGoal(state, activeSession.goal, {
          canAct: props.connected && canCompose,
          onGoalCommand: props.onGoalCommand,
          onGoalEdit: (sessionGoal) => {
            commitComposerDraft(props, `/goal edit ${sessionGoal.objective}`);
            requestUpdate();
            queueMicrotask(() => state.composerTextarea?.focus({ preventScroll: true }));
          },
          requestUpdate,
        })}
      </div>`
    : nothing;

  return html`
    <div
      class="agent-chat__composer-shell"
      @dblclick=${(event: MouseEvent) => {
        const editingId = props.queuedEdit?.editingId;
        if (!editingId) {
          return;
        }
        const target = event.target;
        const row = target instanceof Element ? target.closest<HTMLElement>("[data-chat-queue-item]") : null;
        if (row?.dataset.chatQueueItem !== editingId) {
          props.queuedEdit?.onCancel?.();
        }
      }}
    >
      ${questionPanelProps
        ? html`
            <div class="agent-chat__question-dock">
              <openclaw-chat-question-panel
                .props=${questionPanelProps}
              ></openclaw-chat-question-panel>
            </div>
          `
        : nothing}
      ${disabledBanner} ${progressCard} ${queue} ${goal}
      ${showComposerInput ? nothing : composerAlerts}
      ${showComposerInput
          ? html`<div
            class="agent-chat__input agent-chat__input--chat ${props.offline
              ? "agent-chat__input--offline"
              : ""}${dictation?.active ? " agent-chat__input--dictating" : ""}"
            data-composer-layout="multiline"
            @keydown=${closeChatComposerPickerOnEscape}
            @wa-show=${handleChatComposerDropdownShow}
            @wa-after-show=${restorePointerOpenedChatComposerTrigger}
            @click=${(event: MouseEvent) => focusComposerFromChrome(event, canCompose)}
            @pointerdown=${(event: PointerEvent) => {
              markPointerOpenedChatComposerDropdown(event);
              focusComposerFromChrome(event, canCompose);
            }}
            ${ref(state.composerInputRef ?? undefined)}
          >
            ${slashMenuVisible ? renderSlashMenu(requestUpdate, props, visibleDraft) : nothing}
            ${skillMenuVisible ? renderSkillMenu(state, skillMenuHost, requestUpdate) : nothing}
            <!-- Everything that stacks above the editor lives in one flow region so
                 attachments, replies and status all inset and wrap the same way
                 instead of each optional block carrying its own placement. The
                 absolutely positioned menus above stay outside it: they float over
                 the surface rather than adding a row to it. -->
            <div class="agent-chat__composer-lede">
              ${renderAttachmentPreview(props)}
              ${props.replyTarget
                ? html`
                    <div class="chat-reply-preview">
                      <span class="chat-reply-preview__icon">${icons.messageSquare}</span>
                      <span class="chat-reply-preview__label"
                        >${t("chat.messages.replyingTo", {
                          name: props.replyTarget.senderLabel ?? t("chat.messages.message"),
                        })}</span
                      >
                      <span class="chat-reply-preview__text"
                        >${truncateUtf16Safe(props.replyTarget.text, 120)}${props.replyTarget.text
                          .length > 120
                          ? "..."
                          : ""}</span
                      >
                      <button
                        type="button"
                        class="chat-reply-preview__dismiss"
                        @click=${() => props.onClearReply?.()}
                        aria-label=${t("chat.composer.cancelReply")}
                        title=${t("chat.composer.cancelReply")}
                      >
                        ${icons.x}
                      </button>
                    </div>
                  `
                : nothing}
              <div class="agent-chat__composer-status-stack">
                ${dictation?.active
                  ? html`
                      <div
                        class=${`agent-chat__dictation-status${dictation.finalizing ? " agent-chat__dictation-status--finalizing" : ""}`}
                      >
                        <span class="agent-chat__dictation-wave">
                          ${renderMicrophoneActivity({
                            status: dictation.connecting ? "connecting" : "listening",
                            inputLevel: dictation.inputLevel,
                            bars: 48,
                            mode: "scroll",
                          })}
                        </span>
                      </div>
                    `
                  : nothing}
                ${renderFallbackIndicator(props.fallbackStatus)}
                ${renderCompactionIndicator(props.compactionStatus)}
              </div>

              ${renderChatAttachmentInputs({ ...props, disabled: !canCompose })}
              ${props.realtimeTalkVideoStream
                ? html`
                    <div class="agent-chat__video-preview">
                      <video
                        class=${mirrorCameraPreview
                          ? "agent-chat__video-preview-mirrored"
                          : nothing}
                        autoplay
                        .muted=${true}
                        playsinline
                        aria-label=${t("chat.composer.cameraPreview")}
                        ${ref((element) => {
                          if (element instanceof HTMLVideoElement) {
                            element.srcObject = props.realtimeTalkVideoStream ?? null;
                          }
                        })}
                      ></video>
                      ${props.realtimeTalkCameraDevices &&
                      props.realtimeTalkCameraDevices.length >= 2 &&
                      props.onSwitchRealtimeCamera
                        ? html`
                            <openclaw-tooltip
                              class="agent-chat__video-preview-switch-tooltip"
                              .content=${t("chat.composer.switchCamera")}
                            >
                              <button
                                type="button"
                                class="agent-chat__video-preview-switch"
                                aria-label=${t("chat.composer.switchCamera")}
                                ?disabled=${props.realtimeTalkVideoPending}
                                @click=${props.onSwitchRealtimeCamera}
                              >
                                ${icons.switchCamera}
                              </button>
                            </openclaw-tooltip>
                          `
                        : nothing}
                    </div>
                  `
                : nothing}
            </div>

            <div class="agent-chat__composer-input-row">
              <div class="agent-chat__composer-combobox">
                <textarea
                  ${ref(state.textareaRef ?? undefined)}
                  class=${skillDraftOverlay === nothing ? "" : "agent-chat__composer-textarea--rich"}
                  .value=${dictationPreviewDraft}
                  dir=${detectTextDirection(dictationPreviewDraft)}
                  ?disabled=${!canCompose}
                  ?readonly=${dictation?.locksComposer === true}
                  aria-autocomplete="list"
                  aria-controls=${ifDefined(
                    slashMenuVisible || skillMenuVisible ? slashMenuListboxId : undefined,
                  )}
                  aria-expanded=${ifDefined(
                    slashMenuVisible || skillMenuVisible ? "true" : undefined,
                  )}
                  aria-activedescendant=${ifDefined(activeSlashMenuOptionId ?? undefined)}
                  aria-describedby=${`${slashMenuAnnouncementId}${
                    props.disabledReason ? ` ${disabledReasonId}` : ""
                  }`}
                  aria-keyshortcuts=${sendShortcut === "enter"
                    ? "Enter"
                    : "Control+Enter Meta+Enter"}
                  @keydown=${handleKeyDown}
                  @beforeinput=${handleBeforeInput}
                  @input=${handleInput}
                  @select=${handleSelect}
                  @pointerup=${handleSelect}
                  @compositionstart=${(event: CompositionEvent) => {
                    state.composerComposing = true;
                    state.composingDraft = {
                      key: draftKey,
                      value: (event.target as HTMLTextAreaElement).value,
                    };
                  }}
                  @compositionend=${handleCompositionEnd}
                  @blur=${handleBlur}
                  @paste=${(event: ClipboardEvent) => {
                    if (canCompose && !props.suggestionComposer) {
                      handleChatAttachmentPaste(event, props);
                    }
                  }}
                  aria-label=${placeholder}
                  placeholder=${dictation?.active ? "" : placeholder}
                  rows="1"
                ></textarea>
                ${skillDraftOverlay}
                <span
                  id=${slashMenuAnnouncementId}
                  class="sr-only"
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                  >${activeSlashMenuOptionLabel}</span
                >
                <span
                  class="agent-chat__run-status-announcement sr-only"
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                  >${runStatusAnnouncement}</span
                >
              </div>
            </div>

            <div class="agent-chat__composer-footer">
              <div class="agent-chat__composer-lead">
                ${renderChatComposerPlusMenu({
                  attachments: props,
                  showCapabilities: props.capabilityMenu !== undefined,
                  basePath: props.capabilityMenu?.basePath ?? "",
                  disabled: !canCompose || props.suggestionComposer === true,
                  open: state.capabilityMenuOpen,
                  view: state.capabilityMenuView,
                  toolOverrides: props.toolOverrides,
                  skills: props.capabilityMenu?.skills ?? null,
                  skillsLoading: props.capabilityMenu?.skillsLoading ?? false,
                  skillsError: props.capabilityMenu?.skillsError ?? false,
                  mcpServers: props.capabilityMenu?.mcpServers ?? [],
                  toolsEffectiveResult: props.capabilityMenu?.toolsEffectiveResult ?? null,
                  toolsEffectiveLoading: props.capabilityMenu?.toolsEffectiveLoading ?? false,
                  toolsEffectiveError: props.capabilityMenu?.toolsEffectiveError ?? false,
                  toolAccessMutationBlockedReason:
                    props.capabilityMenu?.toolAccessMutationBlockedReason ?? null,
                  webSearchBaseEnabled: props.capabilityMenu?.webSearchBaseEnabled ?? true,
                  mutationBlockedReason: props.capabilityMenu?.mutationBlockedReason ?? null,
                  canAdmin: props.capabilityMenu?.canAdmin ?? false,
                  adminBlockedReason: props.capabilityMenu?.adminBlockedReason ?? null,
                  addServerDialog: props.capabilityMenu?.addServerDialog,
                  onOpenChange: (open) => {
                    state.capabilityMenuOpen = open;
                    if (!open) {
                      state.capabilityMenuView = "root";
                    }
                    requestUpdate();
                  },
                  onViewChange: (view) => {
                    state.capabilityMenuView = view;
                    requestUpdate();
                  },
                  onLoadSkills: props.capabilityMenu?.onLoadSkills ?? (() => {}),
                  onPatchToolOverrides: props.capabilityMenu?.onPatchToolOverrides ?? (() => {}),
                  onNavigate: props.capabilityMenu?.onNavigate ?? (() => {}),
                  onAddServer: props.capabilityMenu?.onAddServer,
                  onEnsureToolAccess: props.capabilityMenu?.onEnsureToolAccess,
                  onOpenToolAccess: props.capabilityMenu?.onOpenToolAccess,
                })}
                ${props.permissionPicker
                  ? renderChatPermissionPicker(props.permissionPicker)
                  : nothing}
              </div>
              <div class="agent-chat__composer-trail">
                <div class="agent-chat__composer-meta">${contextNotice}</div>
                ${composerControls !== nothing
                  ? html`
                      <div class="agent-chat__composer-controls">
                        ${composerControls}
                      </div>
                    `
                  : nothing}
                <div class="agent-chat__composer-actions">
                  ${renderChatPrimaryActions(runControlsProps)}
                </div>
              </div>
            </div>
          </div>`
        : nothing}
      ${composerUnderlaps}
    </div>
  `;
}
