import { html, nothing, type TemplateResult } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { ref } from "lit/directives/ref.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { icons } from "../../components/icons.ts";
import type { ImageLightboxItem } from "../../components/image-lightbox.ts";
import { t } from "../../i18n/index.ts";
import "../../components/tooltip.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { buildFallbackSlashCommands, type SlashCommandDef } from "../../lib/chat/commands.ts";
import { loadSlashCommandCatalog } from "../../lib/chat/slash-command-catalog.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  createChatAttachmentDropHandlers,
  handleChatAttachmentPaste,
  renderAttachmentPreview,
  renderChatAttachmentInputs,
  renderChatAttachmentMenu,
} from "../chat/components/chat-attachments.ts";
import {
  adjustTextareaHeight,
  disconnectTextareaOverflowObserver,
  observeTextareaOverflow,
  paneDomId,
  scheduleTextareaHeightAdjustment,
} from "../chat/components/chat-composer-dom.ts";
import {
  createSkillMenuState,
  getActiveSkillMenuOptionId,
  getActiveSkillMenuOptionLabel,
  handleSkillMenuKeydown,
  isSkillMenuVisible,
  renderSkillMenu,
  resetSkillMenuState,
  updateSkillMenu,
  type SkillMenuHost,
} from "../chat/components/chat-composer-skill-menu.ts";
import type { NewSessionAttachmentDraft } from "./attachment-draft.ts";
import type { NewSessionVisibility } from "./create-params.ts";
import type { NewSessionModelControl } from "./model-control.ts";

type NewSessionComposerOptions = {
  attachmentLimits?: { maxBytes: number; maxImageBytes: number };
  attachments: ChatAttachment[];
  canSubmit: boolean;
  getAttachments: () => ChatAttachment[];
  message: string;
  modelControl?: TemplateResult | typeof nothing;
  pendingAttachmentReads: number;
  readSignal: AbortSignal;
  requiresModifier: boolean;
  requestUpdate: () => void;
  refreshCommands?: () => void | Promise<void>;
  submitDisabledReason?: string;
  blockedSubmitNotice?: string;
  terminalAction?: {
    canStart: boolean;
    disabledReason?: string;
    onStart: () => void;
  };
  submitting: boolean;
  textareaController: NewSessionComposerTextareaController;
  messageLocked?: boolean;
  visibility?: NewSessionVisibility;
  draftAvailable?: boolean;
  onAttachmentsChange: (attachments: ChatAttachment[]) => void;
  onPendingReadsChange: (delta: 1 | -1) => void;
  onInput: (message: string) => void;
  onOpenImage?: (item: ImageLightboxItem) => void;
  onVisibilityChange?: (visibility: NewSessionVisibility) => void;
  onSubmit: () => void;
};

function submitNewSession(
  options: NewSessionComposerOptions,
  skillMenuState: NewSessionComposerTextareaController["skillMenuState"],
) {
  resetSkillMenuState(skillMenuState);
  options.onSubmit();
}

function renderStartControl(options: NewSessionComposerOptions) {
  const startLabel = options.submitting ? t("newSession.starting") : t("newSession.start");
  if (!options.terminalAction) {
    return html`
      <openclaw-tooltip content=${options.submitDisabledReason ?? t("newSession.start")}>
        <button
          type="button"
          class="chat-send-btn new-session-page__start-submit"
          ?disabled=${!options.canSubmit}
          aria-busy=${String(options.submitting)}
          aria-label=${startLabel}
          @click=${() => submitNewSession(options, options.textareaController.skillMenuState)}
        >
          ${options.submitting ? icons.loader : icons.arrowUp}
        </button>
      </openclaw-tooltip>
    `;
  }
  const terminalLabel = t("newSession.startInTerminal");
  return html`
    <div class="new-session-page__start-split">
      <openclaw-tooltip content=${options.submitDisabledReason ?? t("newSession.start")}>
        <button
          type="button"
          class="chat-send-btn new-session-page__start-submit new-session-page__start-primary"
          ?disabled=${!options.canSubmit}
          aria-busy=${String(options.submitting)}
          aria-label=${startLabel}
          @click=${() => submitNewSession(options, options.textareaController.skillMenuState)}
        >
          ${options.submitting ? icons.loader : icons.arrowUp}
        </button>
      </openclaw-tooltip>
      <openclaw-tooltip content=${options.terminalAction.disabledReason ?? terminalLabel}>
        <wa-dropdown class="new-session-page__start-menu" placement="top-end">
          <button
            slot="trigger"
            type="button"
            class="chat-send-btn new-session-page__start-menu-trigger"
            ?disabled=${!options.terminalAction.canStart}
            aria-label=${terminalLabel}
          >
            ${icons.chevronUp}
          </button>
          <wa-dropdown-item
            value="start-terminal"
            ?disabled=${!options.terminalAction.canStart}
            @click=${() => {
              if (options.terminalAction?.canStart) {
                options.terminalAction.onStart();
              }
            }}
          >
            ${terminalLabel}
          </wa-dropdown-item>
        </wa-dropdown>
      </openclaw-tooltip>
    </div>
  `;
}

export class NewSessionComposerTextareaController {
  private textarea: HTMLTextAreaElement | null = null;
  private commandClient: GatewayBrowserClient | null = null;
  private commandAgentId = "";
  private commandConnectionEpoch = 0;
  private commandGeneration = 0;
  private commandCatalog: readonly SlashCommandDef[] = buildFallbackSlashCommands();
  private reconcileCommandMenu: (() => void) | null = null;
  private commandMenuReconcilePending = false;
  readonly skillMenuState = createSkillMenuState();

  readonly ref = (element?: Element) => {
    const nextTextarea = element instanceof HTMLTextAreaElement ? element : null;
    if (this.textarea && this.textarea !== nextTextarea) {
      disconnectTextareaOverflowObserver(this.textarea);
    }
    this.textarea = nextTextarea;
    if (nextTextarea) {
      observeTextareaOverflow(nextTextarea);
      scheduleTextareaHeightAdjustment(nextTextarea);
    }
  };

  syncDraft(message: string) {
    // The stable ref measures attachment only. Programmatic restores and
    // resets still need a post-render measurement after Lit commits .value.
    if (this.textarea?.isConnected && this.textarea.value !== message) {
      scheduleTextareaHeightAdjustment(this.textarea);
    }
  }

  readonly getTextarea = () => this.textarea;

  syncCommandOwner(client: GatewayBrowserClient | null, agentId: string, connectionEpoch: number) {
    const normalizedAgentId = agentId.trim();
    if (
      this.commandClient === client &&
      this.commandAgentId === normalizedAgentId &&
      this.commandConnectionEpoch === connectionEpoch
    ) {
      return;
    }
    const shouldReconcile =
      this.skillMenuState.skillMenuTarget !== null || this.commandMenuReconcilePending;
    this.commandClient = client;
    this.commandAgentId = normalizedAgentId;
    this.commandConnectionEpoch = connectionEpoch;
    this.invalidateCommandCatalog();
    this.commandMenuReconcilePending = shouldReconcile;
  }

  invalidateCommandCatalog() {
    this.commandGeneration += 1;
    this.commandCatalog = buildFallbackSlashCommands();
    resetSkillMenuState(this.skillMenuState);
  }

  setCommandMenuReconciler(reconcile: () => void) {
    this.reconcileCommandMenu = reconcile;
    this.scheduleCommandMenuReconciliation();
  }

  private scheduleCommandMenuReconciliation(): boolean {
    if (!this.commandMenuReconcilePending || !this.reconcileCommandMenu) {
      return false;
    }
    queueMicrotask(() => {
      if (!this.commandMenuReconcilePending) {
        return;
      }
      this.commandMenuReconcilePending = false;
      this.reconcileCommandMenu?.();
    });
    return true;
  }

  handleGatewayEvent(event: string, requestUpdate: () => void) {
    if (event !== "config.changed" && event !== "skills.changed") {
      return;
    }
    const shouldReconcile =
      this.skillMenuState.skillMenuTarget !== null || this.commandMenuReconcilePending;
    this.invalidateCommandCatalog();
    this.commandMenuReconcilePending = shouldReconcile;
    if (!this.scheduleCommandMenuReconciliation()) {
      requestUpdate();
    }
  }

  async refreshCommandCatalog(
    client: GatewayBrowserClient,
    agentId: string,
    connectionEpoch: number,
  ): Promise<void> {
    this.syncCommandOwner(client, agentId, connectionEpoch);
    const normalizedAgentId = agentId.trim();
    const generation = ++this.commandGeneration;
    const catalog = await loadSlashCommandCatalog(client, normalizedAgentId);
    if (
      this.commandGeneration === generation &&
      this.commandClient === client &&
      this.commandAgentId === normalizedAgentId &&
      this.commandConnectionEpoch === connectionEpoch
    ) {
      this.commandCatalog = catalog;
    }
  }

  readonly getCommandCatalog = () => this.commandCatalog;

  disconnect() {
    this.invalidateCommandCatalog();
    this.commandMenuReconcilePending = false;
    this.reconcileCommandMenu = null;
    this.commandClient = null;
    this.commandAgentId = "";
    this.commandConnectionEpoch = 0;
    if (this.textarea) {
      disconnectTextareaOverflowObserver(this.textarea);
      this.textarea = null;
    }
  }
}

/** Draft visibility pill: selecting it clears incognito, re-click returns to normal. */
function renderVisibilityPill(params: {
  mode: Exclude<NewSessionVisibility, "normal">;
  icon: unknown;
  label: string;
  description: string;
  options: NewSessionComposerOptions;
}) {
  const active = params.options.visibility === params.mode;
  const disabled = params.options.submitting || params.options.messageLocked;
  return html`
    <button
      type="button"
      class="new-session-page__visibility ${active ? "new-session-page__visibility--active" : ""}"
      role="switch"
      aria-checked=${String(active)}
      ?disabled=${disabled}
      title=${params.description}
      @click=${() => params.options.onVisibilityChange?.(active ? "normal" : params.mode)}
    >
      <span aria-hidden="true">${params.icon}</span>${params.label}
    </button>
  `;
}

export function renderDraftError(message: string) {
  return html`
    <div class="callout danger new-session-page__error new-session-page__alert" role="alert">
      <span class="new-session-page__alert-icon" aria-hidden="true">${icons.alertTriangle}</span>
      <span class="callout__content new-session-page__alert-message"
        >${formatUiError(message)}</span
      >
    </div>
  `;
}

function handleComposerKeydown(
  event: KeyboardEvent,
  options: NewSessionComposerOptions,
  skillMenuHost: SkillMenuHost,
) {
  if (event.isComposing || event.keyCode === 229) {
    return;
  }
  if (
    handleSkillMenuKeydown(
      event,
      options.textareaController.skillMenuState,
      skillMenuHost,
      options.requestUpdate,
    )
  ) {
    return;
  }
  if (event.key !== "Enter" || event.shiftKey) {
    return;
  }
  if (options.requiresModifier && !event.metaKey && !event.ctrlKey) {
    return;
  }
  // A reasoned gate still consumes the press: the submission flow records the
  // attempt and surfaces the reason instead of silently inserting a newline.
  // Only silent gates (busy button, empty draft) keep Enter native.
  if (options.canSubmit || options.submitDisabledReason !== undefined) {
    event.preventDefault();
    submitNewSession(options, options.textareaController.skillMenuState);
  }
}

/** Draft message box styled as the chat composer shell so both pickers match. */
function renderNewSessionComposer(options: NewSessionComposerOptions) {
  const skillMenuState = options.textareaController.skillMenuState;
  const skillMenuHost: SkillMenuHost = {
    paneId: "new-session",
    getDraft: () => options.textareaController.getTextarea()?.value ?? options.message,
    commitDraft: options.onInput,
    getTextarea: options.textareaController.getTextarea,
    getCommandCatalog: options.textareaController.getCommandCatalog,
    refreshCommands: options.refreshCommands,
  };
  const updateSkills = (target: HTMLTextAreaElement) =>
    updateSkillMenu(
      target.value,
      target.selectionStart,
      skillMenuState,
      skillMenuHost,
      options.requestUpdate,
    );
  options.textareaController.setCommandMenuReconciler(() => {
    const target = options.textareaController.getTextarea();
    if (target) {
      updateSkills(target);
    } else {
      options.requestUpdate();
    }
  });
  const handleSelect = (event: Event) => {
    const target = event.currentTarget;
    if (target instanceof HTMLTextAreaElement) {
      updateSkills(target);
    }
  };
  const attachmentProps = {
    attachmentLimits: options.attachmentLimits,
    attachments: options.attachments,
    disabled: options.submitting || options.messageLocked,
    getAttachments: options.getAttachments,
    draft: options.message,
    getDraft: () => options.message,
    onAttachmentsChange: options.onAttachmentsChange,
    onDraftChange: options.onInput,
    onPendingReadsChange: options.onPendingReadsChange,
    onOpenImage: options.onOpenImage,
    readSignal: options.readSignal,
  };
  const attachmentDropHandlers = createChatAttachmentDropHandlers({
    ...attachmentProps,
    canCompose: !options.submitting && !options.messageLocked,
  });
  options.textareaController.syncDraft(options.message);
  const skillMenuVisible =
    !options.submitting && !options.messageLocked && isSkillMenuVisible(skillMenuState);
  const skillMenuListboxId = paneDomId(skillMenuHost.paneId, "skill-menu-listbox");
  const activeSkillOptionId = getActiveSkillMenuOptionId(skillMenuState, skillMenuHost.paneId);
  const skillMenuAnnouncementId = paneDomId(skillMenuHost.paneId, "skill-active-announcement");
  return html`
    <div
      class="agent-chat__composer-shell new-session-page__composer"
      @drop=${attachmentDropHandlers.onDrop}
      @dragenter=${attachmentDropHandlers.onDragenter}
      @dragleave=${attachmentDropHandlers.onDragleave}
      @dragover=${attachmentDropHandlers.onDragover}
    >
      <div class="agent-chat__input">
        ${renderChatAttachmentInputs(attachmentProps)} ${renderAttachmentPreview(attachmentProps)}
        <div class="agent-chat__composer-input-row">
          <div class="agent-chat__composer-combobox">
            ${skillMenuVisible
              ? renderSkillMenu(skillMenuState, skillMenuHost, options.requestUpdate)
              : nothing}
            <textarea
              ${ref(options.textareaController.ref)}
              class="new-session-page__message"
              rows="1"
              ?disabled=${options.submitting || options.messageLocked}
              placeholder=${t("newSession.messagePlaceholder")}
              aria-label=${t("newSession.messagePlaceholder")}
              .value=${options.message}
              aria-autocomplete="list"
              aria-controls=${ifDefined(skillMenuVisible ? skillMenuListboxId : undefined)}
              aria-expanded=${ifDefined(skillMenuVisible ? "true" : undefined)}
              aria-activedescendant=${ifDefined(activeSkillOptionId ?? undefined)}
              aria-describedby=${skillMenuAnnouncementId}
              @input=${(event: Event) => {
                const target = event.target as HTMLTextAreaElement;
                adjustTextareaHeight(target);
                updateSkills(target);
                options.onInput(target.value);
              }}
              @select=${handleSelect}
              @keydown=${(event: KeyboardEvent) =>
                handleComposerKeydown(event, options, skillMenuHost)}
              @paste=${(event: ClipboardEvent) => {
                if (!options.submitting && !options.messageLocked) {
                  handleChatAttachmentPaste(event, attachmentProps);
                }
              }}
            ></textarea>
            <span
              id=${skillMenuAnnouncementId}
              class="sr-only"
              role="status"
              aria-live="polite"
              aria-atomic="true"
              >${getActiveSkillMenuOptionLabel(skillMenuState)}</span
            >
          </div>
          <div class="agent-chat__composer-actions">${renderStartControl(options)}</div>
        </div>
        <div class="agent-chat__composer-footer">
          <div class="agent-chat__composer-controls">
            ${renderChatAttachmentMenu(attachmentProps)}
            ${options.modelControl && options.modelControl !== nothing
              ? html`<div class="chat-composer-model-control">${options.modelControl}</div>`
              : nothing}
            ${options.draftAvailable
              ? renderVisibilityPill({
                  mode: "draft",
                  icon: icons.pencil,
                  label: t("newSession.draft"),
                  description: t("newSession.draftDescription"),
                  options,
                })
              : nothing}
          </div>
        </div>
        ${options.blockedSubmitNotice
          ? html`<div class="new-session-page__blocked-submit" role="status">
              ${options.blockedSubmitNotice}
            </div>`
          : nothing}
        ${options.pendingAttachmentReads > 0
          ? html`<span class="sr-only" role="status">${t("newSession.readingAttachment")}</span>`
          : nothing}
      </div>
    </div>
  `;
}

export function renderNewSessionDraftComposer(options: {
  agent?: import("../../api/types.ts").GatewayAgentRow;
  agentId: string;
  connectionEpoch: number;
  attachmentDraft: NewSessionAttachmentDraft;
  canSubmit: boolean;
  context: import("../../app/context.ts").ApplicationContext | undefined;
  isCatalogTarget: boolean;
  message: string;
  visibility?: NewSessionVisibility;
  draftAvailable?: boolean;
  modelControl: NewSessionModelControl;
  textareaController: NewSessionComposerTextareaController;
  requiresModifier: boolean;
  requestUpdate: () => void;
  submitDisabledReason?: string;
  blockedSubmitNotice?: string;
  terminalAction?: {
    canStart: boolean;
    disabledReason?: string;
    onStart: () => void;
  };
  submitting: boolean;
  messageLocked?: boolean;
  onInput: (message: string) => void;
  onOpenImage?: (item: ImageLightboxItem) => void;
  onVisibilityChange?: (visibility: NewSessionVisibility) => void;
  onSubmit: () => void;
}) {
  const readSignal = options.attachmentDraft.readSignal;
  const commandClient = options.context?.gateway.snapshot.client;
  options.textareaController.syncCommandOwner(
    commandClient ?? null,
    options.agentId,
    options.connectionEpoch,
  );
  return renderNewSessionComposer({
    attachmentLimits: options.context?.gateway.snapshot.hello?.policy?.attachments,
    attachments: options.attachmentDraft.attachments,
    canSubmit: options.canSubmit,
    getAttachments: () => options.attachmentDraft.attachments,
    message: options.message,
    visibility: options.visibility,
    draftAvailable: options.draftAvailable,
    modelControl: options.isCatalogTarget
      ? nothing
      : options.modelControl.render({
          agent: options.agent,
          agentId: options.agentId,
          context: options.context,
          sending: options.submitting,
        }),
    pendingAttachmentReads: options.attachmentDraft.pendingReads,
    readSignal,
    requiresModifier: options.requiresModifier,
    requestUpdate: options.requestUpdate,
    refreshCommands: commandClient
      ? () =>
          options.textareaController.refreshCommandCatalog(
            commandClient,
            options.agentId,
            options.connectionEpoch,
          )
      : undefined,
    submitDisabledReason: options.submitDisabledReason,
    blockedSubmitNotice: options.blockedSubmitNotice,
    terminalAction: options.terminalAction,
    submitting: options.submitting,
    textareaController: options.textareaController,
    messageLocked: options.messageLocked,
    onAttachmentsChange: (attachments) => {
      if (!options.submitting && !options.messageLocked) {
        options.attachmentDraft.replace(attachments);
      }
    },
    onPendingReadsChange: (delta) => options.attachmentDraft.updatePending(readSignal, delta),
    onInput: options.onInput,
    onOpenImage: options.onOpenImage,
    onVisibilityChange: options.onVisibilityChange,
    onSubmit: options.onSubmit,
  });
}
