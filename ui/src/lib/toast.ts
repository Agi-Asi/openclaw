import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { formatUiExternalText } from "./format-error.ts";
import { areUiSessionKeysEquivalent } from "./sessions/session-key.ts";

type ToastDismissReason = "action" | "dismiss" | "disconnected" | "replaced" | "timeout";
type ToastVariant = "danger" | "info" | "success" | "warning";

export type ToastOptions = {
  /** A template lets a message name a destination the operator can actually open,
   * instead of spelling out a settings path the toast then makes them find. */
  message: string | TemplateResult;
  // Composer-owned notices intentionally retain the existing neutral single-slot
  // presentation by omitting both fields; migrated global/session outcomes set both.
  key?: string;
  variant?: ToastVariant;
  scope?: { kind: "session"; sessionKey: string };
  actionLabel?: string;
  onAction?: () => void;
  onDismiss?: (reason: ToastDismissReason) => void;
  durationMs?: number;
};

const DEFAULT_TOAST_DURATION_MS = 6_000;
const TOAST_EXIT_DURATION_MS = 150;
const TOAST_QUEUE_LIMIT = 3;

type ToastEntry = ToastOptions & {
  deadline: number;
  id: number;
  exiting: boolean;
};

let nextToastId = 0;

function activeModalToastLayer() {
  return [...(document.openClawModalToastLayers ?? [])].findLast(
    (candidate) => candidate.isConnected,
  );
}

// Outcomes reported during startup can race the shell that owns the host.
// Apply the same bounded queue and key replacement before that host connects.
let queuedToasts: ToastOptions[] = [];
const sessionToastHosts = new Set<OpenClawSessionToastHost>();

abstract class OpenClawToastStackHost extends OpenClawLightDomContentsElement {
  @state() private toasts: ToastEntry[] = [];
  private readonly dismissTimers = new Map<number, ReturnType<typeof globalThis.setTimeout>>();
  protected abstract readonly stackKind: "global" | "session";

  protected dismissAll(reason: ToastDismissReason) {
    for (const toast of this.toasts) {
      this.finishDismiss(toast, reason);
    }
    this.toasts = [];
  }

  show(options: ToastOptions) {
    if (!options.variant) {
      for (const legacyToast of this.toasts.filter((candidate) => !candidate.variant)) {
        this.finishDismiss(legacyToast, "replaced");
      }
      this.toasts = this.toasts.filter((toast) => toast.variant);
    }
    const duplicate = options.key
      ? this.toasts.find((toast) => !toast.exiting && toast.key === options.key)
      : undefined;
    const durationMs = options.durationMs ?? DEFAULT_TOAST_DURATION_MS;
    const entry = {
      ...options,
      deadline: Date.now() + durationMs,
      id: ++nextToastId,
      exiting: false,
    };
    if (duplicate) {
      this.finishDismiss(duplicate, "replaced");
      this.toasts = this.toasts.map((toast) => (toast === duplicate ? entry : toast));
    } else {
      const active = this.toasts.filter((toast) => !toast.exiting && toast.variant);
      if (active.length >= TOAST_QUEUE_LIMIT) {
        const oldest = active[0]!;
        this.finishDismiss(oldest, "replaced");
        this.toasts = this.toasts.filter((toast) => toast !== oldest);
      }
      this.toasts = [...this.toasts, entry];
    }
    this.dismissTimers.set(
      entry.id,
      globalThis.setTimeout(() => this.dismiss(entry, "timeout"), durationMs),
    );
  }

  protected takeActiveToasts(): ToastOptions[] {
    const now = Date.now();
    const active = this.toasts.filter((toast) => !toast.exiting);
    for (const toast of active) {
      this.clearDismissTimer(toast);
    }
    this.toasts = [];
    return active.map(({ deadline, exiting: _exiting, id: _id, ...toast }) =>
      Object.assign(toast, { durationMs: Math.max(0, deadline - now) }),
    );
  }

  private clearDismissTimer(toast: ToastEntry) {
    const timer = this.dismissTimers.get(toast.id);
    if (timer !== undefined) {
      globalThis.clearTimeout(timer);
      this.dismissTimers.delete(toast.id);
    }
  }

  private finishDismiss(toast: ToastEntry, reason: ToastDismissReason) {
    this.clearDismissTimer(toast);
    toast.onDismiss?.(reason);
  }

  private dismiss(toast: ToastEntry, reason: ToastDismissReason) {
    if (toast.exiting || !this.toasts.includes(toast)) {
      return;
    }
    this.finishDismiss(toast, reason);
    this.toasts = this.toasts.map((candidate) =>
      candidate === toast ? { ...candidate, exiting: true } : candidate,
    );
    globalThis.setTimeout(() => {
      this.toasts = this.toasts.filter((candidate) => candidate.id !== toast.id);
    }, TOAST_EXIT_DURATION_MS);
  }

  override render() {
    if (this.toasts.length === 0) {
      return nothing;
    }
    const modern = this.toasts.filter((toast) => toast.variant);
    const legacy = this.toasts.filter((toast) => !toast.variant);
    const renderStack = (toasts: ToastEntry[], kind: "global" | "legacy" | "session") =>
      toasts.length === 0
        ? nothing
        : html`<div class="app-toast-stack app-toast-stack--${kind}">
            ${toasts.map((toast) => {
              const assertive = toast.variant === "warning" || toast.variant === "danger";
              return html`
                <div
                  class="app-toast app-toast--${kind}${toast.variant
                    ? ` app-toast--${toast.variant}`
                    : ""}"
                  data-toast-key=${toast.key ?? toast.id}
                  data-state=${toast.exiting ? "exiting" : "open"}
                  role=${assertive ? "alert" : "status"}
                  aria-live=${assertive ? "assertive" : "polite"}
                  aria-atomic="true"
                >
                  ${toast.variant
                    ? html`<span class="app-toast__indicator" aria-hidden="true"></span>`
                    : nothing}
                  <span class="app-toast__message"
                    >${typeof toast.message === "string"
                      ? formatUiExternalText(toast.message)
                      : toast.message}</span
                  >
                  ${toast.actionLabel && toast.onAction
                    ? html`
                        <button
                          type="button"
                          class="app-toast__action"
                          @click=${() => {
                            this.dismiss(toast, "action");
                            toast.onAction?.();
                          }}
                        >
                          ${toast.actionLabel}
                        </button>
                      `
                    : nothing}
                  <button
                    type="button"
                    class="app-toast__dismiss"
                    aria-label=${t("common.dismiss")}
                    @click=${() => this.dismiss(toast, "dismiss")}
                  >
                    ×
                  </button>
                </div>
              `;
            })}
          </div>`;
    return html`${renderStack(modern, this.stackKind)}${renderStack(legacy, "legacy")}`;
  }
}

class OpenClawToastHost extends OpenClawToastStackHost {
  protected readonly stackKind = "global";

  override connectedCallback() {
    super.connectedCallback();
    const pending = queuedToasts;
    queuedToasts = [];
    for (const toast of pending) {
      this.show(toast);
    }
  }

  override disconnectedCallback() {
    const target = activeModalToastLayer() ?? document.querySelector(".shell");
    if (!this.isConnected && this.parentElement?.localName === "openclaw-modal-dialog" && target) {
      target.append(this);
    } else {
      this.dismissAll("disconnected");
    }
    super.disconnectedCallback();
  }

  /** Keep the active outcome intact while moveBefore() crosses top-layer owners. */
  connectedMoveCallback() {}
}

class OpenClawSessionToastHost extends OpenClawToastStackHost {
  protected readonly stackKind = "session";
  @property({ attribute: false }) sessionKey = "";
  @property({ attribute: false }) presented = false;
  @property({ attribute: false }) active = false;

  override connectedCallback() {
    super.connectedCallback();
    sessionToastHosts.add(this);
  }

  override disconnectedCallback() {
    sessionToastHosts.delete(this);
    this.dismissAll("disconnected");
    super.disconnectedCallback();
  }

  protected override updated(changedProperties: PropertyValues<this>) {
    super.updated(changedProperties);
    if (changedProperties.has("presented") && !this.presented) {
      for (const toast of this.takeActiveToasts()) {
        presentGlobalToast(toast);
      }
    }
  }
}

function matchingSessionToastHost(sessionKey: string): OpenClawSessionToastHost | undefined {
  return [...sessionToastHosts]
    .filter(
      (host) =>
        host.presented &&
        host.isConnected &&
        areUiSessionKeysEquivalent(host.sessionKey, sessionKey),
    )
    .toSorted((left, right) => Number(right.active) - Number(left.active))[0];
}

export function renderSessionToastHost(params: {
  sessionKey: string;
  presented: boolean;
  active: boolean;
}) {
  return html`<openclaw-session-toast-host
    .sessionKey=${params.sessionKey}
    .presented=${params.presented}
    .active=${params.active}
  ></openclaw-session-toast-host>`;
}

export function showToast(options: ToastOptions): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  const host = document.querySelector<OpenClawToastHost>("openclaw-toast-host");
  if (!host) {
    const duplicate = options.key
      ? queuedToasts.findIndex((toast) => toast.key === options.key)
      : -1;
    if (duplicate >= 0) {
      queuedToasts[duplicate]?.onDismiss?.("replaced");
      queuedToasts[duplicate] = options;
    } else {
      if (queuedToasts.length >= TOAST_QUEUE_LIMIT) {
        queuedToasts.shift()?.onDismiss?.("replaced");
      }
      queuedToasts.push(options);
    }
    return false;
  }
  const modal = activeModalToastLayer();
  if (modal && host.parentElement !== modal) {
    modal.moveBefore(host, null);
    const handoff = (event: Event) => {
      if (event.target !== modal) {
        return;
      }
      modal.removeEventListener("wa-after-hide", handoff);
      queueMicrotask(() =>
        (activeModalToastLayer() ?? document.querySelector(".shell"))?.moveBefore(host, null),
      );
    };
    modal.addEventListener("wa-after-hide", handoff);
  }
  if (!modal && options.scope?.kind === "session") {
    const sessionHost = matchingSessionToastHost(options.scope.sessionKey);
    if (sessionHost) {
      sessionHost.show(options);
      return true;
    }
  }
  return presentGlobalToast(options, host);
}

function presentGlobalToast(
  options: ToastOptions,
  host = document.querySelector<OpenClawToastHost>("openclaw-toast-host"),
): boolean {
  if (!host) {
    return false;
  }
  host.show(options);
  return true;
}

// Guarded so DOM-free (node) consumers of send-failure surfacing can load this module.
if (typeof customElements !== "undefined" && !customElements.get("openclaw-toast-host")) {
  customElements.define("openclaw-toast-host", OpenClawToastHost);
}
if (typeof customElements !== "undefined" && !customElements.get("openclaw-session-toast-host")) {
  customElements.define("openclaw-session-toast-host", OpenClawSessionToastHost);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-toast-host": OpenClawToastHost;
    "openclaw-session-toast-host": OpenClawSessionToastHost;
  }
}
