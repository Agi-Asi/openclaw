import type { GatewaySessionRow } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";

type ChatSessionRunError = { summary: string };

export function resolveChatSessionRunError(
  session: GatewaySessionRow | undefined,
  placementTerminalReason: string | undefined,
): ChatSessionRunError | null {
  const durableError = session?.lastRunError?.trim();
  if (session && durableError && (session.status === "failed" || session.status === "timeout")) {
    return { summary: durableError };
  }
  return placementTerminalReason
    ? { summary: t("chat.cloudWorkerFailed", { error: placementTerminalReason }) }
    : null;
}
