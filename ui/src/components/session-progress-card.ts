import type { ProgressCard, ProgressCardStep } from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { t } from "../i18n/index.ts";
import { icons } from "./icons.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

type SessionProgressCardPlacement = "board" | "composer" | "hovercard" | "rail";

const STATUS_LABEL_KEYS: Record<ProgressCardStep["status"], Parameters<typeof t>[0]> = {
  completed: "sessionProgressCard.status.completed",
  in_progress: "sessionProgressCard.status.inProgress",
  pending: "sessionProgressCard.status.pending",
};

function progressCounts(card: ProgressCard): { completed: number; total: number } | null {
  const steps = card.steps;
  if (!steps?.length) {
    return null;
  }
  return {
    completed: steps.filter((step) => step.status === "completed").length,
    total: steps.length,
  };
}

function currentProgressStep(steps: readonly ProgressCardStep[]): ProgressCardStep | undefined {
  return (
    steps.find((step) => step.status === "in_progress") ??
    steps.find((step) => step.status === "pending") ??
    steps.findLast((step) => step.status === "completed")
  );
}

function currentProgressPosition(steps: readonly ProgressCardStep[]): number {
  const current = currentProgressStep(steps);
  const index = current ? steps.indexOf(current) : -1;
  return Math.max(1, index + 1);
}

function renderMarkdown(markdown: string | undefined) {
  if (!markdown) {
    return nothing;
  }
  return html`<div class="session-progress-card__markdown sidebar-markdown">
    ${unsafeHTML(toSanitizedMarkdownHtml(markdown, { progressBars: true }))}
  </div>`;
}

function renderSteps(card: ProgressCard) {
  const steps = card.steps;
  if (!steps?.length) {
    return nothing;
  }
  return html`<ol class="session-progress-card__steps">
    ${steps.map((step) => {
      const statusLabel = t(STATUS_LABEL_KEYS[step.status]);
      const marker =
        step.status === "completed"
          ? icons.check
          : step.status === "in_progress"
            ? html`<span class="session-run-spinner"></span>`
            : icons.circle;
      return html`<li
        class="session-progress-card__step session-progress-card__step--${step.status}"
        aria-label=${t("sessionProgressCard.stepLabel", { status: statusLabel, step: step.step })}
      >
        <span class="session-progress-card__step-marker" aria-hidden="true">${marker}</span>
        <span class="session-progress-card__step-text">${step.step}</span>
      </li>`;
    })}
  </ol>`;
}

function renderBody(card: ProgressCard) {
  return html`<div class="session-progress-card__body">
    ${renderMarkdown(card.markdown)} ${renderSteps(card)}
  </div>`;
}

export function renderSessionProgressCard(
  card: ProgressCard | null | undefined,
  placement: SessionProgressCardPlacement,
  onDismiss?: (card: ProgressCard) => void,
) {
  if (!card) {
    return nothing;
  }
  const counts = progressCounts(card);
  const countLabel = counts
    ? t("sessionProgressCard.countLabel", {
        completed: String(counts.completed),
        total: String(counts.total),
      })
    : t("sessionProgressCard.noteLabel");
  const dismissible = Boolean(
    onDismiss && card.steps?.length && card.steps.every((step) => step.status === "completed"),
  );
  const dismiss = dismissible
    ? html`<button
        class="rail-header__action session-progress-card__dismiss"
        type="button"
        aria-label=${t("sessionProgressCard.dismiss")}
        title=${t("sessionProgressCard.dismiss")}
        @click=${(event: MouseEvent) => {
          event.preventDefault();
          event.stopPropagation();
          onDismiss?.(card);
        }}
      >
        ${icons.x}
      </button>`
    : nothing;
  if (placement === "composer") {
    const steps = card.steps ?? [];
    const currentStep = currentProgressStep(steps);
    const currentPosition = currentProgressPosition(steps);
    const complete = steps.length > 0 && steps.every((step) => step.status === "completed");
    const composerCountLabel = counts
      ? t("sessionProgressCard.countLabel", {
          completed: String(currentPosition),
          total: String(counts.total),
        })
      : t("sessionProgressCard.noteLabel");
    const stepLabel = currentStep?.step ?? t("sessionProgressCard.noteLabel");
    const shortCount = counts
      ? t("sessionProgressCard.shortCount", {
          completed: String(currentPosition),
          total: String(counts.total),
        })
      : nothing;
    const summaryIndicator = complete
      ? icons.check
      : currentStep?.status === "in_progress"
        ? html`<span class="session-run-spinner"></span>`
        : icons.circle;
    return html`<div
      class="session-progress-card session-progress-card--composer"
      data-progress-card-placement="composer"
      data-open="false"
    >
      <div
        class="session-progress-card__summary"
        aria-label=${composerCountLabel}
      >
        <span
          class="session-progress-card__summary-indicator${complete
            ? " session-progress-card__summary-indicator--complete"
            : ""}"
          aria-hidden="true"
        >
          ${summaryIndicator}
        </span>
        <span class="session-progress-card__current">${stepLabel}</span>
        ${counts
          ? html`<span class="session-progress-card__summary-count"
              >${currentPosition}/${counts.total}</span
            >`
          : nothing}
      </div>
      <div class="session-progress-card__body" role="region" aria-label=${composerCountLabel}>
        <div class="session-progress-card__heading">
          <span>${t("sessionProgressCard.composerTitle")}</span>
          <span class="session-progress-card__heading-actions">
            ${shortCount} ${dismiss}
          </span>
        </div>
        ${counts
          ? html`<progress
              class="session-progress-card__progress"
              value=${currentPosition}
              max=${counts.total}
              aria-label=${composerCountLabel}
            ></progress>`
          : nothing}
        ${renderMarkdown(card.markdown)} ${renderSteps(card)}
      </div>
    </div>`;
  }
  return html`<section
    class="session-progress-card session-progress-card--${placement}"
    data-progress-card-placement=${placement}
    aria-label=${countLabel}
  >
    ${counts
      ? html`<div class="session-progress-card__heading">
          <span>${t("sessionProgressCard.title")}</span>
          <span class="session-progress-card__heading-actions">
            <span>${counts.completed}/${counts.total}</span>
            ${dismiss}
          </span>
        </div>`
      : nothing}
    ${renderBody(card)}
  </section>`;
}
