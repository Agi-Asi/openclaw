#!/usr/bin/env bash

send() {
  local payload="$1"
  local delay="${2:-0.4}"
  # Let prompts render before sending keystrokes.
  sleep "$delay"
  printf "%b" "$payload" >&3 2>/dev/null || true
}

log_contains() {
  local needle="$1"
  if [ -z "${WIZARD_LOG_PATH:-}" ] || [ ! -f "$WIZARD_LOG_PATH" ]; then
    return 1
  fi
  if grep -a -F -q "$needle" "$WIZARD_LOG_PATH"; then
    return 0
  fi
  node scripts/e2e/lib/onboard/log-contains.mjs "$WIZARD_LOG_PATH" "$needle"
}

wait_for_log() {
  local needle="$1"
  local timeout_s="${2:-45}"
  local quiet_on_timeout="${3:-false}"
  local start_s
  start_s="$(date +%s)"
  while true; do
    if log_contains "$needle"; then
      return 0
    fi
    if [ $(($(date +%s) - start_s)) -ge "$timeout_s" ]; then
      if [ "$quiet_on_timeout" = "true" ]; then
        return 1
      fi
      echo "Timeout waiting for log: $needle"
      if [ -n "${WIZARD_LOG_PATH:-}" ] && [ -f "$WIZARD_LOG_PATH" ]; then
        tail -n 140 "$WIZARD_LOG_PATH" || true
      fi
      return 1
    fi
    sleep 0.2
  done
}

decline_telemetry_and_wait_for_agent_name() {
  local timeout_s="${1:-45}"
  wait_for_log "No thanks" "$timeout_s" || return $?
  send $'\r' 0.4
  wait_for_log "What should we call your first agent?" "$timeout_s"
}
