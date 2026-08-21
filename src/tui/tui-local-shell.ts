// Launches and manages the local shell process used by TUI local mode.
import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { Component, OverlayHandle, SelectItem } from "@earendil-works/pi-tui";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { tryProcessCwd } from "../infra/safe-cwd.js";
import { killProcessTree } from "../process/kill-tree.js";
import { createSearchableSelectList } from "./components/selectors.js";
import { formatTuiErrorMessage } from "./tui-formatters.js";

type LocalShellDeps = {
  chatLog: {
    addSystem: (line: string) => void;
  };
  tui: {
    requestRender: () => void;
  };
  openOverlay: (component: Component) => OverlayHandle;
  closeOverlay: (handle?: OverlayHandle) => void;
  createSelector?: (
    items: SelectItem[],
    maxVisible: number,
  ) => Component & {
    onSelect?: (item: SelectItem) => void;
    onCancel?: () => void;
  };
  spawnCommand?: typeof spawn;
  getCwd?: () => string | undefined;
  env?: NodeJS.ProcessEnv;
  maxOutputChars?: number;
};

const LOCAL_SHELL_FORCE_EXIT_MS = 1_000;

type ActiveLocalShell = {
  child: ChildProcess;
  finishRun: () => void;
  removeOutputListeners: () => void;
};

function isChildRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function stopLocalShell(child: ChildProcess): void {
  if (child.pid) {
    killProcessTree(child.pid, {
      detached: process.platform !== "win32",
      graceMs: LOCAL_SHELL_FORCE_EXIT_MS,
    });
    return;
  }
  child.kill("SIGTERM");
}

export function createLocalShellRunner(deps: LocalShellDeps) {
  let localExecAsked = false;
  let localExecAllowed = false;
  let closed = false;
  let pendingApproval: { handle: OverlayHandle; resolve: (allowed: boolean) => void } | null = null;
  const active = new Set<ActiveLocalShell>();
  const createSelector = deps.createSelector ?? createSearchableSelectList;
  const spawnCommand = deps.spawnCommand ?? spawn;
  const getCwd = deps.getCwd ?? tryProcessCwd;
  const env = deps.env ?? process.env;
  const maxChars = deps.maxOutputChars ?? 40_000;

  const ensureLocalExecAllowed = async (): Promise<boolean> => {
    if (localExecAllowed) {
      return true;
    }
    if (localExecAsked) {
      return false;
    }
    localExecAsked = true;

    return await new Promise<boolean>((resolve) => {
      deps.chatLog.addSystem("Allow local shell commands for this session?");
      deps.chatLog.addSystem(
        "This runs commands on YOUR machine (not the gateway) and may delete files or reveal secrets.",
      );
      deps.chatLog.addSystem("Select Yes/No (arrows + Enter), Esc to cancel.");
      const selector = createSelector(
        [
          { value: "no", label: "No" },
          { value: "yes", label: "Yes" },
        ],
        2,
      );
      selector.onSelect = (item: SelectItem) => {
        if (closed) {
          resolve(false);
          return;
        }
        pendingApproval = null;
        deps.closeOverlay(overlayHandle);
        if (item.value === "yes") {
          localExecAllowed = true;
          deps.chatLog.addSystem("local shell: enabled for this session");
          resolve(true);
        } else {
          deps.chatLog.addSystem("local shell: not enabled");
          resolve(false);
        }
        deps.tui.requestRender();
      };
      selector.onCancel = () => {
        if (closed) {
          resolve(false);
          return;
        }
        pendingApproval = null;
        deps.closeOverlay(overlayHandle);
        deps.chatLog.addSystem("local shell: cancelled");
        deps.tui.requestRender();
        resolve(false);
      };
      const overlayHandle: OverlayHandle = deps.openOverlay(selector);
      pendingApproval = { handle: overlayHandle, resolve };
      deps.tui.requestRender();
    });
  };

  const runLocalShellLine = async (line: string) => {
    if (closed) {
      return;
    }
    const cmd = line.slice(1);
    // NOTE: A lone '!' is handled by the submit handler as a normal message.
    // Keep this guard anyway in case this is called directly.
    if (cmd === "") {
      return;
    }

    if (localExecAsked && !localExecAllowed) {
      deps.chatLog.addSystem("local shell: not enabled for this session");
      deps.tui.requestRender();
      return;
    }

    const allowed = await ensureLocalExecAllowed();
    if (!allowed || closed) {
      return;
    }

    // A shell command's meaning depends on its directory; never retarget it implicitly.
    const cwd = getCwd();
    if (!cwd) {
      deps.chatLog.addSystem(
        "local shell: working directory was deleted; cd to an existing directory first",
      );
      deps.tui.requestRender();
      return;
    }

    deps.chatLog.addSystem(`[local] $ ${cmd}`);
    deps.tui.requestRender();

    const appendWithCap = (text: string, chunk: string) => {
      const combined = text + chunk;
      return combined.length > maxChars ? sliceUtf16Safe(combined, -maxChars) : combined;
    };

    await new Promise<void>((resolve) => {
      const child = spawnCommand(cmd, {
        // Intentionally a shell: this is an operator-only local TUI feature (prefixed with `!`)
        // and is gated behind an explicit in-session approval prompt.
        shell: true,
        detached: process.platform !== "win32",
        cwd,
        env: { ...env, OPENCLAW_SHELL: "tui-local" },
      });

      let finishRun = () => {};
      let stdout = "";
      let stderr = "";
      let error: Error | undefined;
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      // Pipe errors are incidental; close owns completion after any recorded spawn error.
      const ignoreOutputStreamError = () => {};
      const onStdout = (buf: Buffer) => {
        stdout = appendWithCap(stdout, stdoutDecoder.write(buf));
      };
      const onStderr = (buf: Buffer) => {
        stderr = appendWithCap(stderr, stderrDecoder.write(buf));
      };
      const removeOutputListeners = () => {
        child.stdout?.removeListener("error", ignoreOutputStreamError);
        child.stderr?.removeListener("error", ignoreOutputStreamError);
        child.stdout?.removeListener("data", onStdout);
        child.stderr?.removeListener("data", onStderr);
      };
      child.stdout.on("error", ignoreOutputStreamError);
      child.stderr.on("error", ignoreOutputStreamError);
      child.stdout.on("data", onStdout);
      child.stderr.on("data", onStderr);

      const owned: ActiveLocalShell = {
        child,
        finishRun: () => finishRun(),
        removeOutputListeners,
      };
      active.add(owned);

      const clearOwned = () => {
        removeOutputListeners();
        active.delete(owned);
      };

      const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
        clearOwned();
        child.removeListener?.("error", onError);
        child.removeListener?.("close", onClose);
        if (closed) {
          finishRun();
          return;
        }
        stdout = appendWithCap(stdout, stdoutDecoder.end());
        stderr = appendWithCap(stderr, stderrDecoder.end());
        // Keep the tail (consistent with the streaming appendWithCap above) so a
        // large stdout cannot evict stderr: the failure reason (FATAL etc.) at the
        // end is what the operator needs most when output overflows the cap.
        const combined = sliceUtf16Safe(
          stdout + (stderr ? (stdout ? "\n" : "") + stderr : ""),
          -maxChars,
        ).trimEnd();

        if (combined) {
          for (const lineLocal of combined.split("\n")) {
            deps.chatLog.addSystem(`[local] ${lineLocal}`);
          }
        }
        const status = error ? `error: ${formatTuiErrorMessage(error)}` : `exit ${code ?? "?"}`;
        deps.chatLog.addSystem(`[local] ${status}${signal ? ` (signal ${signal})` : ""}`);
        deps.tui.requestRender();
        finishRun();
      };

      const onError = (err: Error) => {
        error = err;
      };
      child.on("close", onClose);
      child.on("error", onError);

      let settled = false;
      finishRun = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
    });
  };

  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    if (pendingApproval) {
      deps.closeOverlay(pendingApproval.handle);
      pendingApproval.resolve(false);
      pendingApproval = null;
    }
    for (const owned of active) {
      owned.removeOutputListeners();
      owned.finishRun();
      if (!isChildRunning(owned.child)) {
        continue;
      }
      stopLocalShell(owned.child);
    }
  };

  return { close, runLocalShellLine };
}
