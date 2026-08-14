import { html, nothing, type TemplateResult } from "lit";
import "../../../components/elapsed-time.ts";
import { t } from "../../../i18n/index.ts";
import { formatDurationCompact } from "../../../lib/format.ts";
import { isActiveTask, taskStatusLabel, taskTimingFacts } from "../../../lib/tasks/data.ts";
import type { TaskSummary } from "../../../lib/tasks/task-summary.ts";

export { newestTaskSnapshot } from "../../../lib/tasks/data.ts";

// Status tone drives the meta line's colored word and the running pulse dot;
// pill chips read too heavy at rail width, so tone is typographic only.
// Shared with the status row's hover preview.
export const STATUS_TONES = {
  queued: "warn",
  running: "warn",
  completed: "ok",
  failed: "danger",
  cancelled: "danger",
  timed_out: "danger",
} as const satisfies Record<TaskSummary["status"], string>;

export function backgroundTaskStatusLabel(task: TaskSummary): string {
  if (isActiveTask(task)) {
    return taskStatusLabel(task.status);
  }
  // Finished history intentionally has two outcomes: completed or failed.
  // Cancellation and timeout stay grouped as unsuccessful work.
  return task.status === "completed"
    ? t("tasksPage.status.completed")
    : t("tasksPage.status.failed");
}

export function renderBackgroundTaskTiming(task: TaskSummary): TemplateResult | typeof nothing {
  const timing = taskTimingFacts(task);
  if (!timing) {
    return nothing;
  }
  if (timing.kind === "worked") {
    return html`${t("chat.workRun.workedFor", {
      duration: formatDurationCompact(timing.endMs - timing.startMs) ?? "0s",
    })}`;
  }
  return html`${t(
      timing.kind === "waiting" ? "tasksPage.activity.waitFor" : "tasksPage.activity.workFor",
    )} <openclaw-elapsed-time .startMs=${timing.startMs}></openclaw-elapsed-time>`;
}
