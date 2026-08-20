// Setup-only signal-cli JSON-RPC transport bound to one child process.
import { createInterface } from "node:readline";
import { generateSecureUuid } from "openclaw/plugin-sdk/core";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SignalRpcOptions } from "./client.js";
import {
  formatSignalDaemonExit,
  spawnSignalJsonRpcProcess,
  type SignalJsonRpcProcess,
} from "./daemon.js";

type PendingRequest = {
  id: string;
  maxResponseBytes: number;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type SignalLinkRpcClient = {
  request: (
    method: string,
    params?: Record<string, unknown>,
    options?: Pick<SignalRpcOptions, "timeoutMs" | "maxResponseBytes">,
  ) => Promise<unknown>;
  stop: () => Promise<void>;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024;

class SignalLinkRpcProcessClient implements SignalLinkRpcClient {
  private readonly lines;
  private pending: PendingRequest | undefined;
  private terminalError: Error | undefined;

  constructor(
    private readonly process: SignalJsonRpcProcess,
    private readonly abortSignal?: AbortSignal,
  ) {
    this.lines = createInterface({ input: process.stdout });
    this.lines.on("line", this.handleLine);
    process.stdin.on("error", this.fail);
    process.stdout.on("error", this.fail);
    void process.exited.then((exit) => this.fail(new Error(formatSignalDaemonExit(exit))));
    abortSignal?.addEventListener("abort", this.onAbort, { once: true });
  }

  async request(
    method: string,
    params?: Record<string, unknown>,
    options?: Pick<SignalRpcOptions, "timeoutMs" | "maxResponseBytes">,
  ): Promise<unknown> {
    if (this.terminalError) {
      throw this.terminalError;
    }
    if (this.pending) {
      throw new Error("signal-cli link RPC request already in flight");
    }
    this.abortSignal?.throwIfAborted();
    const id = generateSecureUuid();
    const timeoutMs = this.positiveInteger(options?.timeoutMs, DEFAULT_TIMEOUT_MS);
    const maxResponseBytes = this.positiveInteger(
      options?.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
    );
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        reject(new Error(`signal-cli jsonRpc timeout (${method})`));
      }, timeoutMs);
      timer.unref?.();
      this.pending = {
        id,
        maxResponseBytes,
        resolve,
        reject,
        timer,
      };
    });
    try {
      this.process.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method, params, id })}\n`,
        (error?: Error | null) => {
          if (error) {
            this.fail(error);
          }
        },
      );
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
    return await response;
  }

  async stop(): Promise<void> {
    this.abortSignal?.removeEventListener("abort", this.onAbort);
    this.lines.close();
    await this.process.stop();
  }

  private positiveInteger(value: number | undefined, fallback: number): number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
  }

  private readonly onAbort = () => void this.process.stop();

  private readonly handleLine = (line: string) => {
    const pending = this.pending;
    if (!pending || !line.trim()) {
      return;
    }
    if (Buffer.byteLength(line) > pending.maxResponseBytes) {
      this.fail(new Error("signal-cli jsonRpc response exceeded size limit"));
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.fail(new Error("signal-cli jsonRpc returned malformed JSON"));
      return;
    }
    if (!isRecord(parsed) || typeof parsed.id !== "string" || parsed.id !== pending.id) {
      return;
    }
    this.pending = undefined;
    clearTimeout(pending.timer);
    if (isRecord(parsed.error)) {
      const code = typeof parsed.error.code === "number" ? ` ${parsed.error.code}` : "";
      const message =
        typeof parsed.error.message === "string"
          ? parsed.error.message.slice(0, 512)
          : "request failed";
      pending.reject(new Error(`signal-cli jsonRpc${code}: ${message}`));
    } else if (Object.hasOwn(parsed, "result")) {
      pending.resolve(parsed.result);
    } else {
      pending.reject(new Error("signal-cli jsonRpc returned an invalid response"));
    }
  };

  private readonly fail = (error: Error) => {
    if (this.terminalError) {
      return;
    }
    this.terminalError = error;
    const pending = this.pending;
    this.pending = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    void this.process.stop();
  };
}

export function createSignalLinkRpcClient(options: {
  cliPath: string;
  configPath?: string;
  abortSignal?: AbortSignal;
}): SignalLinkRpcClient {
  const { abortSignal, ...processOptions } = options;
  return new SignalLinkRpcProcessClient(spawnSignalJsonRpcProcess(processOptions), abortSignal);
}
