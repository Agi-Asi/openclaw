import type { GatewaySessionRow } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";

export function describeSessionRunActivity(
  runActivity: GatewaySessionRow["runActivity"],
  hasActiveRun = false,
): string | undefined {
  if (runActivity?.state !== "waiting") {
    return runActivity?.state === "working" || hasActiveRun
      ? t("sessionsView.activeRun")
      : undefined;
  }
  const queueWait = runActivity.queueWait;
  return [
    t("sessionsView.waitingToRun"),
    queueWait
      ? t("sessionsView.sessionsAhead", { count: String(queueWait.queuedAhead) })
      : undefined,
    queueWait
      ? t("sessionsView.slotsBusy", {
          busy: String(queueWait.busySlots),
          capacity: String(queueWait.capacity),
        })
      : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}
