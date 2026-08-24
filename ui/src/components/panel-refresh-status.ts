import { nothing, type TemplateResult } from "lit";
import { t } from "../i18n/index.ts";
import { formatUiError } from "../lib/format-error.ts";
import { renderPanelState } from "./panel-state.ts";

export type PanelRefreshStatus = Readonly<{
  error: string | null;
  hasLoaded: boolean;
  stale: boolean;
}>;

export function createPanelRefreshStatus(): PanelRefreshStatus {
  return { error: null, hasLoaded: false, stale: false };
}

export function beginPanelRefresh(
  status: PanelRefreshStatus,
  options?: { clearError?: boolean },
): PanelRefreshStatus {
  return {
    ...status,
    error: options?.clearError === false ? status.error : null,
  };
}

export function completePanelRefresh(): PanelRefreshStatus {
  return { error: null, hasLoaded: true, stale: false };
}

export function failPanelRefresh(status: PanelRefreshStatus, error: string): PanelRefreshStatus {
  return {
    error: formatUiError(error),
    hasLoaded: status.hasLoaded,
    stale: status.hasLoaded,
  };
}

export function renderPanelRefreshStatus(params: {
  status: PanelRefreshStatus;
  errorMessage?: string;
  onRetry: () => void;
  className?: string;
}): TemplateResult | typeof nothing {
  const { status } = params;
  const rawError = params.errorMessage ?? status.error;
  const error = rawError ? formatUiError(rawError) : rawError;
  if (!error && !status.stale) {
    return nothing;
  }
  if (!error) {
    return renderPanelState(
      { kind: "notice", message: t("common.staleData") },
      { className: params.className },
    );
  }
  return renderPanelState(
    { kind: "error", error, stale: status.stale, onRetry: params.onRetry },
    { className: params.className, layout: "callout" },
  );
}
