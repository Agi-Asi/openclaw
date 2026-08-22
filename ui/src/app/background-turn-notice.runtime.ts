import type { GatewaySessionRow } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { resolveSessionDisplayName } from "../lib/session-display.ts";
import type { SessionBackgroundTurnOutcome } from "../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  uiSessionEventMatches,
  type UiSessionDefaultsHost,
} from "../lib/sessions/session-key.ts";
import { showToast, type ToastOptions } from "../lib/toast.ts";

const pendingNotices: ToastOptions[] = [];
let noticeActive = false;

function showNextNotice(): void {
  if (noticeActive) {
    return;
  }
  const next = pendingNotices.shift();
  if (!next) {
    return;
  }
  noticeActive = true;
  showToast({
    ...next,
    onDismiss: (reason) => {
      next.onDismiss?.(reason);
      noticeActive = false;
      showNextNotice();
    },
  });
}

function enqueueNotice(options: ToastOptions): void {
  pendingNotices.push(options);
  showNextNotice();
}

export function showBackgroundTurnNotice(params: {
  sessionHost: UiSessionDefaultsHost;
  sessions: readonly GatewaySessionRow[];
  selectedSessionKey: string;
  onOpen: (sessionKey: string, agentId?: string) => void;
  outcome: SessionBackgroundTurnOutcome;
}): void {
  const { outcome } = params;
  if (
    uiSessionEventMatches(
      { ...params.sessionHost, sessionKey: params.selectedSessionKey },
      outcome.key,
      outcome.agentId,
    )
  ) {
    return;
  }
  const row = params.sessions.find((session) =>
    areUiSessionKeysEquivalent(session.key, outcome.key),
  );
  const session = resolveSessionDisplayName(outcome.key, row);
  const status =
    outcome.status === "completed"
      ? t("sessionsView.statusDone")
      : outcome.status === "aborted"
        ? t("sessionsView.statusKilled")
        : outcome.status === "initial-turn-rejected"
          ? t("sessionsView.runFailedReason", { reason: outcome.errorMessage })
          : outcome.status === "initial-turn-idle"
            ? t("sessionsView.statusIdle")
            : outcome.status === "tracking-interrupted"
              ? t("sessionsView.statusUnknown")
              : outcome.errorKind === "timeout"
                ? t("sessionsView.statusTimeout")
                : outcome.errorMessage
                  ? t("sessionsView.runFailedReason", { reason: outcome.errorMessage })
                  : t("sessionsView.statusFailed");
  enqueueNotice({
    message: `${session}: ${status}`,
    actionLabel: t("sessionsView.openSession"),
    onAction: () => params.onOpen(outcome.key, outcome.agentId),
  });
}
