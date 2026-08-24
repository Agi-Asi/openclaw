import { html, nothing, type TemplateResult } from "lit";
import { t } from "../i18n/index.ts";
import { formatUiError } from "../lib/format-error.ts";
import { icon } from "./icons.ts";
import "./openclaw-mascot.ts";

type PanelState =
  | { kind: "loading" }
  | {
      kind: "empty";
      icon: TemplateResult;
      heading: string;
      description: string;
      action?: TemplateResult;
    }
  | {
      kind: "error";
      error: unknown;
      onRetry: (event: Event) => void;
      actionLabel?: string;
      onClose?: (event: Event) => void;
      render?: () => unknown;
      stale?: boolean;
      subtitle?: string;
    }
  | { kind: "notice"; message: string };

export function renderPanelState(
  state: PanelState,
  options: { className?: string; layout?: "centered" | "callout" } = {},
) {
  if (state.kind === "loading") {
    return html`<section
      class="lazy-view-state lazy-view-state--loading ${options.className ?? ""}"
      role="status"
      aria-live="polite"
      aria-label=${t("common.loading")}
    >
      <openclaw-mascot mood="thinking" .size=${120}></openclaw-mascot>
    </section>`;
  }
  if (state.kind === "empty") {
    return html`<div class="lazy-view-error panel-state--empty" role="status">
      <div class="lazy-view-error__icon" aria-hidden="true">${state.icon}</div>
      <strong class="lazy-view-error__title">${state.heading}</strong>
      <p class="lazy-view-error__subtitle">${state.description}</p>
      ${state.action ? html`<div class="lazy-view-error__actions">${state.action}</div>` : nothing}
    </div>`;
  }
  if (state.kind === "notice") {
    return html`<div class="callout warn ${options.className ?? ""}" role="status">
      <strong>${state.message}</strong>
    </div>`;
  }
  const detail = formatUiError(state.error);
  if (options.layout === "callout") {
    return html`<div class="callout danger callout--action ${options.className ?? ""}" role="alert">
      <span class="callout__content">
        ${detail}${state.stale ? html`<br /><strong>${t("common.staleData")}</strong>` : nothing}
      </span>
      <button class="btn btn--sm" type="button" @click=${state.onRetry}>
        ${state.actionLabel ?? t("common.retry")}
      </button>
    </div>`;
  }
  const errorClasses = `lazy-view-error${state.render ? " lazy-view-error--inline" : ""}${state.stale ? " lazy-view-error--stale" : ""} ${options.className ?? ""}`;
  return html`${state.render?.() ?? nothing}
    <div class=${errorClasses} role="alert">
      <div class="lazy-view-error__icon" aria-hidden="true">
        ${icon(state.stale ? "refresh" : "alertTriangle")}
      </div>
      <div class="lazy-view-error__title">
        ${state.stale ? t("lazyView.staleTitle") : t("lazyView.errorTitle")}
      </div>
      <div class="lazy-view-error__subtitle">
        ${state.subtitle ??
        (state.stale ? t("lazyView.staleSubtitle") : t("lazyView.genericSubtitle"))}
      </div>
      <div class="lazy-view-error__actions">
        <button class="btn lazy-view-error__action" type="button" @click=${state.onRetry}>
          ${state.actionLabel ?? (state.stale ? t("common.reload") : t("lazyView.retry"))}
        </button>
        ${state.onClose
          ? html`<button class="btn" type="button" @click=${state.onClose}>
              ${t("common.close")}
            </button>`
          : nothing}
      </div>
      <code class="lazy-view-error__detail">${detail}</code>
    </div>`;
}

export function renderPanelEmptyState(params: {
  icon: TemplateResult;
  heading: string;
  description: string;
  action?: TemplateResult;
}) {
  return renderPanelState({ kind: "empty", ...params });
}

export const renderLoadingState = () => renderPanelState({ kind: "loading" });
export const renderLazyViewError = (params: Omit<Extract<PanelState, { kind: "error" }>, "kind">) =>
  renderPanelState({ kind: "error", ...params });

type LazyElementState =
  | { status: "loading"; element: { label: string } }
  | { status: "error"; element: { label: string }; error: unknown; stale: boolean };

export function renderLazyElementState(
  state: LazyElementState,
  onRetry: () => void,
  onClose: () => void,
) {
  return state.status === "loading"
    ? renderLoadingState()
    : renderLazyViewError({
        actionLabel: t("common.retry"),
        error: state.error,
        stale: state.stale,
        subtitle: state.element.label,
        onRetry,
        onClose,
      });
}

export function renderLazyElementModal(controller: {
  visibleState: LazyElementState | undefined;
  retry(): void;
  close(): void;
}) {
  const state = controller.visibleState;
  if (!state) {
    return nothing;
  }
  const close = () => controller.close();
  return html`<openclaw-modal-dialog label=${state.element.label} @modal-cancel=${close}>
    ${renderLazyElementState(state, () => controller.retry(), close)}
  </openclaw-modal-dialog>`;
}
