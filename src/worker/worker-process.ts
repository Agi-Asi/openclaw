import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { signalProcessTree } from "../process/kill-tree.js";
import type { WorkerBrowserRuntime } from "./browser-runtime.js";
import {
  NODE_WORKER_CONNECTION_FAILURE_MESSAGE_TYPE,
  NODE_WORKER_EXECUTION_STARTED_MESSAGE_TYPE,
  type NodeWorkerConnectionFailureMessage,
} from "./node-supervisor-protocol.js";
import { runWorkerCommand, type WorkerCommandLifetime } from "./worker-command.runtime.js";

const WORKER_START_MESSAGE_TYPE = "openclaw-worker-start-v1";

function parseWorkerStartMessage(value: unknown): { launchId: string; planHash: string } | null {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 3 ||
    value.type !== WORKER_START_MESSAGE_TYPE ||
    typeof value.launchId !== "string" ||
    value.launchId.length === 0 ||
    typeof value.planHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.planHash)
  ) {
    return null;
  }
  return { launchId: value.launchId, planHash: value.planHash };
}

/**
 * Shared by the host-side container shim. The shim is still the durable
 * supervisor child, so a container never begins before `markRunning` opens
 * this inherited Node IPC gate.
 */
export function createWorkerIpcLifetime(): WorkerCommandLifetime {
  if (!process.connected || !process.channel || typeof process.send !== "function") {
    throw new Error("internal worker IPC mode requires a connected Node IPC channel");
  }
  const abortController = new AbortController();
  let disposed = false;
  let started = false;
  let settled = false;
  let startIdentity: { launchId: string; planHash: string } | undefined;
  let executionReported = false;
  let resolveStarted!: (started: boolean) => void;
  let rejectStarted!: (error: Error) => void;
  const startedPromise = new Promise<boolean>((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });
  const rejectOrAbort = (error: Error) => {
    if (!settled) {
      settled = true;
      rejectStarted(error);
      return;
    }
    abortController.abort(error);
  };
  const onMessage = (message: unknown) => {
    if (disposed) {
      return;
    }
    const identity = parseWorkerStartMessage(message);
    if (!identity || settled) {
      rejectOrAbort(new Error("invalid internal worker IPC start message"));
      return;
    }
    started = true;
    startIdentity = identity;
    settled = true;
    resolveStarted(true);
  };
  const onDisconnect = () => {
    if (disposed) {
      return;
    }
    if (!settled) {
      settled = true;
      resolveStarted(false);
      return;
    }
    if (started) {
      abortController.abort(new Error("worker supervisor lifetime ended"));
    }
  };
  process.on("message", onMessage);
  process.once("disconnect", onDisconnect);
  return {
    started: startedPromise,
    signal: abortController.signal,
    reportExecutionStarted: () => {
      if (
        disposed ||
        executionReported ||
        !startIdentity ||
        !process.connected ||
        typeof process.send !== "function"
      ) {
        return;
      }
      executionReported = true;
      try {
        process.send(
          {
            type: NODE_WORKER_EXECUTION_STARTED_MESSAGE_TYPE,
            launchId: startIdentity.launchId,
            planHash: startIdentity.planHash,
          },
          () => {},
        );
      } catch {
        // The disconnect handler owns shutdown when the supervisor is gone.
      }
    },
    reportConnectionFailure: (cause) => {
      if (disposed || !process.connected || typeof process.send !== "function") {
        return;
      }
      const message: NodeWorkerConnectionFailureMessage = {
        type: NODE_WORKER_CONNECTION_FAILURE_MESSAGE_TYPE,
        cause: cause ?? null,
      };
      try {
        process.send(message, () => {});
      } catch {
        // The disconnect handler owns worker shutdown when the supervisor is gone.
      }
    },
    terminateOwnedTree: () => {
      signalProcessTree(process.pid, "SIGKILL", {
        detached: process.platform !== "win32",
      });
    },
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
      if (process.connected) {
        try {
          process.disconnect?.();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ERR_IPC_DISCONNECTED") {
            throw error;
          }
        }
      }
    },
  };
}

/** Runs the worker-only process entry without loading the general CLI command tree. */
export async function runWorkerProcess(
  options: {
    internalWorkerIpc?: boolean;
    browserRuntime?: WorkerBrowserRuntime;
  } = {},
): Promise<void> {
  await runWorkerCommand({
    input: process.stdin,
    output: process.stdout,
    ...(options.internalWorkerIpc ? { lifetime: createWorkerIpcLifetime() } : {}),
    ...(options.browserRuntime ? { browserRuntime: options.browserRuntime } : {}),
  });
}
