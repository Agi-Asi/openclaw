import type { GatewaySessionRow } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { resolveSessionDisplayName } from "../lib/session-display.ts";
import type { SessionBackgroundTurnOutcome } from "../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  uiSessionEventMatches,
  type UiSessionDefaultsHost,
} from "../lib/sessions/session-key.ts";
import { queueToast } from "../lib/toast.ts";
import type { ShellGatewayHost } from "./app-shell-gateway.ts";

function showBackgroundTurnNotice(params: {
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
  queueToast({
    message: `${session}: ${status}`,
    actionLabel: t("sessionsView.openSession"),
    onAction: () => params.onOpen(outcome.key, outcome.agentId),
  });
}

export function showBackgroundNotice(
  host: ShellGatewayHost,
  outcome: SessionBackgroundTurnOutcome,
): void {
  const context = host.context;
  if (!context) {
    return;
  }
  showBackgroundTurnNotice({
    outcome,
    selectedSessionKey: host.activeSessionKey,
    sessionHost: host.storedOutboxScopeHost(context),
    sessions: context.sessions.state.result?.sessions ?? [],
    onOpen: (sessionKey, agentId) => host.selectChatSession(sessionKey, agentId),
  });
}
