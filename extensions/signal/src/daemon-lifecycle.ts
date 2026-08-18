import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { waitForTransportReady } from "openclaw/plugin-sdk/transport-ready-runtime";
import { signalCheck } from "./client-adapter.js";
import { formatSignalDaemonExit, type SignalDaemonHandle } from "./daemon.js";

export async function waitForSignalDaemonReady(params: {
  baseUrl: string;
  abortSignal?: AbortSignal;
  timeoutMs: number;
  logAfterMs: number;
  logIntervalMs?: number;
  runtime: RuntimeEnv;
  waitForTransportReadyFn?: typeof waitForTransportReady;
}): Promise<void> {
  const waitForTransportReadyFn = params.waitForTransportReadyFn ?? waitForTransportReady;
  await waitForTransportReadyFn({
    label: "signal daemon",
    timeoutMs: params.timeoutMs,
    logAfterMs: params.logAfterMs,
    logIntervalMs: params.logIntervalMs,
    pollIntervalMs: 150,
    abortSignal: params.abortSignal,
    runtime: params.runtime,
    check: async () => {
      const res = await signalCheck(params.baseUrl, 1000);
      if (res.ok) {
        return { ok: true };
      }
      return {
        ok: false,
        error: res.error ?? (res.status ? `HTTP ${res.status}` : "unreachable"),
      };
    },
  });
}

export function createSignalDaemonLifecycle(params: { abortSignal?: AbortSignal }) {
  let daemonHandle: SignalDaemonHandle | null = null;
  let daemonStopRequested = false;
  let daemonStopPromise: Promise<void> | undefined;
  let daemonExitError: Error | undefined;
  const daemonAbortController = new AbortController();
  const abortSignal = params.abortSignal
    ? AbortSignal.any([params.abortSignal, daemonAbortController.signal])
    : daemonAbortController.signal;
  const stop = (): Promise<void> => {
    if (daemonStopPromise) {
      return daemonStopPromise;
    }
    daemonStopRequested = true;
    if (!daemonAbortController.signal.aborted) {
      daemonAbortController.abort(
        params.abortSignal?.reason ?? new Error("Signal monitor stopped"),
      );
    }
    daemonStopPromise = daemonHandle?.stop() ?? Promise.resolve();
    return daemonStopPromise;
  };
  const attach = (handle: SignalDaemonHandle) => {
    daemonHandle = handle;
    void handle.exited.then((exit) => {
      if (daemonStopRequested || params.abortSignal?.aborted) {
        return;
      }
      daemonExitError = new Error(formatSignalDaemonExit(exit));
      if (!daemonAbortController.signal.aborted) {
        daemonAbortController.abort(daemonExitError);
      }
    });
  };
  return { attach, stop, getExitError: () => daemonExitError, abortSignal };
}
