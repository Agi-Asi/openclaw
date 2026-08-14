import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../../../components/icons.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import {
  partitionTasks,
  taskActiveSummaryLabel,
  taskStatusLabel,
  taskTimingFacts,
  taskTitle,
} from "../../../lib/tasks/data.ts";
import type { TaskSummary } from "../../../lib/tasks/task-summary.ts";
import { renderBackgroundTaskTiming, STATUS_TONES } from "./chat-background-tasks-shared.ts";
import type { BackgroundTasksProps } from "./chat-background-tasks.types.ts";
import { renderSubagentActivity } from "./chat-subagent-activity.ts";

/** Rows the hover preview shows before deferring to the rail's full list. */
const STATUS_PREVIEW_LIMIT = 5;

function renderStatusPreviewRow(task: TaskSummary): TemplateResult {
  const tone = STATUS_TONES[task.status];
  const timing = taskTimingFacts(task);
  return html`
    <div class="chat-tasks-preview__row">
      ${task.status === "running"
        ? html`<span class="chat-tasks-rail__task-pulse" aria-hidden="true"></span>`
        : nothing}
      <span class="chat-tasks-preview__title">${taskTitle(task)}</span>
      <span class="chat-tasks-preview__meta">
        <span class="chat-tasks-rail__task-status chat-tasks-rail__task-status--${tone}"
          >${taskStatusLabel(task.status)}</span
        >
        ${timing
          ? html`<span class="chat-tasks-rail__task-sep" aria-hidden="true">·</span>
              <span>${renderBackgroundTaskTiming(task)}</span>`
          : nothing}
      </span>
    </div>
  `;
}

/** Hover/focus preview on the status row: the latest tasks at a glance
 * without opening the rail. Content is read-only — a tooltip is a transient
 * surface, so actions stay in the rail the click opens. */
function renderStatusPreview(remainingTasks: readonly TaskSummary[]): TemplateResult {
  const { active, recent } = partitionTasks(remainingTasks);
  const tasks = [...active, ...recent];
  const preview = tasks.slice(0, STATUS_PREVIEW_LIMIT);
  const overflow = tasks.length - preview.length;
  return html`
    <div slot="content" class="chat-tasks-preview">
      ${preview.map((task) => renderStatusPreviewRow(task))}
      ${overflow > 0
        ? html`<div class="chat-tasks-preview__more">
            ${t("agentTools.more", { count: String(overflow) })}
          </div>`
        : nothing}
    </div>
  `;
}

/** Post-turn status row in the chat thread: once the agent turn settles while
 * background tasks keep running, the running work stays visible next to a
 * free composer. Hover previews the latest tasks; the link opens the tasks
 * rail (noop when already open). */
export function renderBackgroundTasksStatusRow(
  backgroundTasks: BackgroundTasksProps | undefined,
): TemplateResult | typeof nothing {
  // Disconnected snapshots are stale: task events cannot arrive, so a ticking
  // "running" claim would be a lie. The rail owns the disconnected state.
  if (!backgroundTasks?.connected) {
    return nothing;
  }
  const subagentActivity = renderSubagentActivity(
    backgroundTasks.subagentActivity,
    backgroundTasks.onOpenTaskDetail,
  );
  const remainingTasks = (backgroundTasks.tasks ?? []).filter(
    (task) => !backgroundTasks.subagentActivity.taskIds.has(task.id),
  );
  const label = taskActiveSummaryLabel(remainingTasks);
  if (subagentActivity === nothing && !label) {
    return nothing;
  }
  if (!label) {
    return subagentActivity;
  }
  const openRail = () => {
    if (backgroundTasks.collapsed) {
      backgroundTasks.onToggleCollapsed();
    }
  };
  // Keep the live announcement separate from the tooltip: rich preview
  // content must not enter the polite region, while the popup must anchor to
  // the link itself or its center drifts with the claw and elapsed time.
  const aggregate = html`
    <div class="chat-tasks-status" id=${backgroundTasks.statusRowId}>
      <span class="chat-tasks-status__claw" aria-hidden="true">${icons.claw}</span>
      <span class="sr-only" role="status">${label}</span>
      <openclaw-tooltip class="chat-tasks-status__preview">
        <button class="chat-tasks-status__link" type="button" @click=${openRail}>${label}</button>
        ${renderStatusPreview(remainingTasks)}
      </openclaw-tooltip>
    </div>
  `;
  return subagentActivity === nothing ? aggregate : html`${subagentActivity}${aggregate}`;
}
