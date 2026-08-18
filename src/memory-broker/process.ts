import { fork } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMemoryBrokerClient, type MemoryBrokerClient } from "./client.js";

const MEMORY_BROKER_START_TIMEOUT_MS = 10_000;
const MEMORY_BROKER_HEALTH_TIMEOUT_MS = 1_000;
const MEMORY_BROKER_MAINTENANCE_TIMEOUT_MS = 10_000;

function createMemoryBrokerChildEnvironment(): NodeJS.ProcessEnv {
  const childEnvironment: NodeJS.ProcessEnv = {};
  // The selected runtime resolves its canonical SQLite/artifact state from this small set. Do not
  // inherit the Gateway's provider tokens, plugin credentials, or arbitrary operator environment.
  for (const name of ["HOME", "OPENCLAW_STATE_DIR", "TMPDIR", "TEMP", "TMP"] as const) {
    const value = process.env[name];
    if (value !== undefined) {
      childEnvironment[name] = value;
    }
  }
  return childEnvironment;
}

export type MemoryBrokerProcess = Readonly<{
  client: MemoryBrokerClient;
  brokerEpoch: string;
  /** A dead child is never reused: its socket, secret, and epoch are all retired. */
  isRunning(): boolean;
  /** Health travels only over the inherited parent-child IPC channel, never the broker socket. */
  isHealthy(): Promise<boolean>;
  /** Gateway-only maintenance travels over inherited IPC, never the agent-visible broker socket. */
  quiesce(): Promise<void>;
  resume(): Promise<void>;
  close(): Promise<void>;
}>;

/**
 * Gateway owns this child and the bootstrap secret. The secret crosses only Node's inherited IPC
 * channel after fork; it is never placed in config, environment, argv, agent state, or a worker
 * launch descriptor. A restart gives the replacement child a new epoch and secret.
 */
export async function startMemoryBrokerProcess(params: {
  brokerId: string;
  handlerModuleUrl: string;
  childModuleUrl?: string | URL;
  startTimeoutMs?: number;
}): Promise<MemoryBrokerProcess> {
  const directory = await mkdtemp(path.join(tmpdir(), "openclaw-memory-broker-"));
  const socketPath = path.join(directory, "broker.sock");
  const brokerEpoch = randomUUID();
  const secret = randomBytes(32);
  const defaultChildModuleUrl = new URL(
    import.meta.url.endsWith(".ts") ? "./child.ts" : "./child.js",
    import.meta.url,
  );
  const childModuleUrl = params.childModuleUrl ?? defaultChildModuleUrl;
  const childModulePath =
    childModuleUrl instanceof URL ? fileURLToPath(childModuleUrl) : childModuleUrl;
  const needsTypeScriptLoader = childModulePath.endsWith(".ts");
  const inheritedLoaderArgs = process.execArgv.flatMap((argument, index, argv) => {
    // A child must execute its module, not replay a parent `node -e`/REPL command. Keep loader
    // flags from source-checkout test runners, but discard their evaluation payload and input mode.
    if (
      argument === "--eval" ||
      argument === "-e" ||
      (index > 0 && (argv[index - 1] === "--eval" || argv[index - 1] === "-e")) ||
      argument.startsWith("--input-type")
    ) {
      return [];
    }
    return [argument];
  });
  const hasTypeScriptLoader = inheritedLoaderArgs.some(
    (argument) => argument === "tsx" || argument.includes("/tsx/"),
  );
  const childExecArgv = needsTypeScriptLoader
    ? hasTypeScriptLoader
      ? inheritedLoaderArgs
      : [...inheritedLoaderArgs, "--import", "tsx"]
    : [];
  const child = fork(childModulePath, [], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    execArgv: childExecArgv,
    env: createMemoryBrokerChildEnvironment(),
  });
  let childExited = false;
  let directoryRemoved = false;
  const removeDirectory = async () => {
    if (directoryRemoved) {
      return;
    }
    directoryRemoved = true;
    await rm(directory, { recursive: true, force: true });
  };
  child.once("exit", () => {
    childExited = true;
    // An unexpected exit must not leave a broker socket directory or an apparently live lease.
    // The Gateway recreates the child with a fresh epoch on the next operation.
    void removeDirectory();
  });
  let startupStderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    // Startup diagnostics never include request bodies or the parent-child secret. Keep enough
    // text to distinguish a missing module from a child protocol failure without retaining logs.
    startupStderr = `${startupStderr}${chunk.toString("utf8")}`.slice(-4_096);
  });
  let settled = false;
  const startTimeoutMs = params.startTimeoutMs ?? MEMORY_BROKER_START_TIMEOUT_MS;
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("error", onError);
        child.off("exit", onExit);
        error ? reject(error) : resolve();
      };
      const onMessage = (message: unknown) => {
        if (
          message &&
          typeof message === "object" &&
          !Array.isArray(message) &&
          (message as { type?: unknown }).type === "ready" &&
          (message as { brokerEpoch?: unknown }).brokerEpoch === brokerEpoch
        ) {
          finish();
          return;
        }
        finish(new Error("memory broker child did not become ready"));
      };
      const onError = () => finish(new Error("memory broker child failed to start"));
      const onExit = () => {
        const detail = startupStderr.trim().replaceAll(/\s+/gu, " ").slice(-512);
        finish(
          new Error(
            detail
              ? `memory broker child exited during startup: ${detail}`
              : "memory broker child exited during startup",
          ),
        );
      };
      const timer = setTimeout(
        () => finish(new Error("memory broker child startup timed out")),
        startTimeoutMs,
      );
      child.once("message", onMessage);
      child.once("error", onError);
      child.once("exit", onExit);
      child.send({
        type: "start",
        socketPath,
        brokerId: params.brokerId,
        brokerEpoch,
        secret: secret.toString("base64url"),
        handlerModuleUrl: params.handlerModuleUrl,
      });
    });
  } catch (error) {
    child.kill();
    await removeDirectory();
    throw error;
  }
  const client = createMemoryBrokerClient({
    socketPath,
    brokerId: params.brokerId,
    brokerEpoch,
    secret,
  });
  const isHealthy = async (): Promise<boolean> => {
    if (childExited || child.exitCode !== null || child.killed || !child.connected) {
      return false;
    }
    return await new Promise<boolean>((resolve) => {
      const requestId = randomUUID();
      let settled = false;
      const finish = (healthy: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        child.off("message", onMessage);
        resolve(healthy);
      };
      const onMessage = (message: unknown) => {
        if (
          message &&
          typeof message === "object" &&
          !Array.isArray(message) &&
          (message as { type?: unknown }).type === "health" &&
          (message as { requestId?: unknown }).requestId === requestId &&
          (message as { brokerEpoch?: unknown }).brokerEpoch === brokerEpoch
        ) {
          finish((message as { ok?: unknown }).ok === true);
        }
      };
      const timer = setTimeout(() => finish(false), MEMORY_BROKER_HEALTH_TIMEOUT_MS);
      timer.unref?.();
      child.on("message", onMessage);
      child.send({ type: "health", requestId, brokerEpoch }, (error) => {
        if (error) {
          finish(false);
        }
      });
    });
  };
  const maintain = async (operation: "quiesce" | "resume"): Promise<void> => {
    if (childExited || child.exitCode !== null || child.killed || !child.connected) {
      throw new Error("memory broker child is unavailable for maintenance");
    }
    const requestId = randomUUID();
    const ok = await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        child.off("message", onMessage);
        resolve(value);
      };
      const onMessage = (message: unknown) => {
        if (
          message &&
          typeof message === "object" &&
          !Array.isArray(message) &&
          (message as { type?: unknown }).type === "maintenance" &&
          (message as { requestId?: unknown }).requestId === requestId &&
          (message as { brokerEpoch?: unknown }).brokerEpoch !== brokerEpoch
        ) {
          finish(false);
          return;
        }
        if (
          message &&
          typeof message === "object" &&
          !Array.isArray(message) &&
          (message as { type?: unknown }).type === "maintenance" &&
          (message as { requestId?: unknown }).requestId === requestId
        ) {
          finish((message as { ok?: unknown }).ok === true);
        }
      };
      const timer = setTimeout(() => finish(false), MEMORY_BROKER_MAINTENANCE_TIMEOUT_MS);
      timer.unref?.();
      child.on("message", onMessage);
      child.send({ type: "maintenance", requestId, brokerEpoch, operation }, (error) => {
        if (error) {
          finish(false);
        }
      });
    });
    if (!ok) {
      throw new Error(`memory broker ${operation} is unavailable`);
    }
  };
  return Object.freeze({
    client,
    brokerEpoch,
    isRunning: () => !childExited && child.exitCode === null && !child.killed,
    isHealthy,
    quiesce: () => maintain("quiesce"),
    resume: () => maintain("resume"),
    close: async () => {
      await maintain("quiesce").catch(() => undefined);
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.killed) {
          resolve();
          return;
        }
        child.once("exit", () => resolve());
        child.disconnect();
        setTimeout(() => child.kill(), 1_000).unref();
      });
      await removeDirectory();
    },
  });
}
