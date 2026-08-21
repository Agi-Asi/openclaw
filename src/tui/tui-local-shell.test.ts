// Verifies local shell process handling for TUI local mode.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import type { OverlayHandle } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

const killTreeMocks = vi.hoisted(() => ({ killProcessTree: vi.fn() }));

vi.mock("../process/kill-tree.js", () => ({
  killProcessTree: killTreeMocks.killProcessTree,
}));

import { createLocalShellRunner } from "./tui-local-shell.js";

const createSelector = () => {
  const selector = {
    onSelect: undefined as ((item: { value: string; label: string }) => void) | undefined,
    onCancel: undefined as (() => void) | undefined,
    render: () => ["selector"],
    invalidate: () => {},
  };
  return selector;
};

function createOverlayHandle(): OverlayHandle {
  return {
    hide: vi.fn(),
    setHidden: vi.fn(),
    isHidden: vi.fn(() => false),
    focus: vi.fn(),
    unfocus: vi.fn(),
    isFocused: vi.fn(() => true),
  };
}

function createShellHarness(params?: {
  spawnCommand?: typeof import("node:child_process").spawn;
  getCwd?: () => string | undefined;
  env?: Record<string, string>;
  maxOutputChars?: number;
}) {
  const messages: string[] = [];
  const chatLog = {
    addSystem: (line: string) => {
      messages.push(line);
    },
  };
  const tui = { requestRender: vi.fn() };
  const overlayHandle = createOverlayHandle();
  const openOverlay = vi.fn(() => overlayHandle);
  const closeOverlay = vi.fn();
  let lastSelector: ReturnType<typeof createSelector> | null = null;
  const createSelectorSpy = vi.fn(() => {
    lastSelector = createSelector();
    return lastSelector;
  });
  const spawnCommand = params?.spawnCommand ?? vi.fn();
  const { close, runLocalShellLine } = createLocalShellRunner({
    chatLog,
    tui,
    openOverlay,
    closeOverlay,
    createSelector: createSelectorSpy,
    spawnCommand,
    ...(params?.getCwd ? { getCwd: params.getCwd } : {}),
    ...(params?.env ? { env: params.env } : {}),
    ...(params?.maxOutputChars !== undefined ? { maxOutputChars: params.maxOutputChars } : {}),
  });
  return {
    messages,
    openOverlay,
    overlayHandle,
    closeOverlay,
    createSelectorSpy,
    spawnCommand,
    requestRender: tui.requestRender,
    close,
    runLocalShellLine,
    getLastSelector: () => lastSelector,
  };
}

function requireSpawnOptions(spawnCommand: ReturnType<typeof vi.fn>): {
  detached?: boolean;
  env?: Record<string, string>;
} {
  const call = spawnCommand.mock.calls[0];
  if (!call) {
    throw new Error("expected spawn command call");
  }
  return call[1] as { detached?: boolean; env?: Record<string, string> };
}

function createRunningChild(pid: number) {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null,
    kill: vi.fn(),
    pid,
    signalCode: null,
    stderr: new EventEmitter(),
    stdout: new EventEmitter(),
  });
  return child;
}

function closeChild(child: ReturnType<typeof createRunningChild>, signal: NodeJS.Signals | null) {
  Object.assign(child, { exitCode: signal ? null : 0, signalCode: signal });
  child.emit("close", signal ? null : 0, signal);
}

describe("createLocalShellRunner", () => {
  it("exposes a lifecycle close owner", () => {
    const harness = createShellHarness();

    expect(harness.close).toEqual(expect.any(Function));
  });

  it("ignores command starts after close", async () => {
    const harness = createShellHarness();
    harness.close();

    await harness.runLocalShellLine("!echo late");

    expect(harness.spawnCommand).not.toHaveBeenCalled();
    expect(harness.openOverlay).not.toHaveBeenCalled();
  });

  it("retires pending approval without accepting stale selector callbacks", async () => {
    const harness = createShellHarness();
    const run = harness.runLocalShellLine("!echo late");
    const selector = harness.getLastSelector();
    const messageCount = harness.messages.length;
    const renderCount = harness.requestRender.mock.calls.length;

    harness.close();
    await run;
    selector?.onSelect?.({ value: "yes", label: "Yes" });

    expect(harness.messages).toHaveLength(messageCount);
    expect(harness.requestRender).toHaveBeenCalledTimes(renderCount);
    expect(harness.closeOverlay).toHaveBeenCalledOnce();
    expect(harness.spawnCommand).not.toHaveBeenCalled();
  });

  it("retires overlapping process groups once", async () => {
    killTreeMocks.killProcessTree.mockReset();
    const children = [createRunningChild(201), createRunningChild(202)];
    const spawnCommand = vi.fn(() => children.shift()!);
    const harness = createShellHarness({
      spawnCommand: spawnCommand as unknown as typeof import("node:child_process").spawn,
    });
    const first = harness.runLocalShellLine("!first");
    harness.getLastSelector()?.onSelect?.({ value: "yes", label: "Yes" });
    await vi.waitFor(() => expect(spawnCommand).toHaveBeenCalledTimes(1));
    const second = harness.runLocalShellLine("!second");
    await vi.waitFor(() => expect(spawnCommand).toHaveBeenCalledTimes(2));
    const [firstChild, secondChild] = spawnCommand.mock.results.map(
      (result) => result.value as ReturnType<typeof createRunningChild>,
    );
    if (!firstChild || !secondChild) {
      throw new Error("expected two spawned local shell children");
    }

    harness.close();
    harness.close();
    await Promise.all([first, second]);

    const detached = process.platform !== "win32";
    expect(killTreeMocks.killProcessTree.mock.calls).toEqual([
      [201, { detached, graceMs: 1_000 }],
      [202, { detached, graceMs: 1_000 }],
    ]);
    closeChild(firstChild, "SIGTERM");
    closeChild(secondChild, "SIGKILL");
  });

  it("clears normal completion listeners and never renders output after close", async () => {
    killTreeMocks.killProcessTree.mockReset();
    const child = createRunningChild(203);
    const harness = createShellHarness({
      spawnCommand: vi.fn(() => child) as unknown as typeof import("node:child_process").spawn,
    });
    const run = harness.runLocalShellLine("!quiet");
    harness.getLastSelector()?.onSelect?.({ value: "yes", label: "Yes" });
    await vi.waitFor(() => expect(child.listenerCount("close")).toBe(1));
    const messageCount = harness.messages.length;

    harness.close();
    child.stdout.emit("data", Buffer.from("late output"));
    closeChild(child, "SIGTERM");
    await run;

    expect(harness.messages).toHaveLength(messageCount);
    expect(child.listenerCount("close")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.stdout.listenerCount("data")).toBe(0);
    expect(killTreeMocks.killProcessTree).toHaveBeenCalledTimes(1);
  });

  it("logs denial on subsequent ! attempts without re-prompting", async () => {
    const harness = createShellHarness();

    const firstRun = harness.runLocalShellLine("!ls");
    expect(harness.openOverlay).toHaveBeenCalledTimes(1);
    const selector = harness.getLastSelector();
    selector?.onSelect?.({ value: "no", label: "No" });
    await firstRun;

    await harness.runLocalShellLine("!pwd");

    expect(harness.messages).toContain("local shell: not enabled");
    expect(harness.messages).toContain("local shell: not enabled for this session");
    expect(harness.createSelectorSpy).toHaveBeenCalledTimes(1);
    expect(harness.spawnCommand).not.toHaveBeenCalled();
    expect(harness.closeOverlay).toHaveBeenCalledWith(harness.overlayHandle);
  });

  it("sets OPENCLAW_SHELL when running local shell commands", async () => {
    const spawnCommand = vi.fn((_command: string, _options: unknown) => {
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      return {
        stdout,
        stderr,
        on: (event: string, callback: (...args: unknown[]) => void) => {
          if (event === "close") {
            setImmediate(() => callback(0, null));
          }
        },
      };
    });

    const harness = createShellHarness({
      spawnCommand: spawnCommand as unknown as typeof import("node:child_process").spawn,
      env: { PATH: "/tmp/bin", USER: "dev" },
    });

    const firstRun = harness.runLocalShellLine("!echo hi");
    expect(harness.openOverlay).toHaveBeenCalledTimes(1);
    const selector = harness.getLastSelector();
    selector?.onSelect?.({ value: "yes", label: "Yes" });
    await firstRun;

    expect(harness.createSelectorSpy).toHaveBeenCalledTimes(1);
    expect(spawnCommand).toHaveBeenCalledTimes(1);
    const spawnOptions = requireSpawnOptions(spawnCommand);
    expect(spawnOptions.env?.OPENCLAW_SHELL).toBe("tui-local");
    expect(spawnOptions.env?.PATH).toBe("/tmp/bin");
    expect(harness.messages).toContain("local shell: enabled for this session");
  });

  it("keeps stderr visible instead of evicting it when stdout fills the output cap", async () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const spawnCommand = vi.fn(() => ({
      stdout,
      stderr,
      on: (event: string, callback: (...args: unknown[]) => void) => {
        if (event === "close") {
          setImmediate(() => {
            // stdout fills the entire cap; stderr then carries the failure reason.
            stdout.emit("data", Buffer.from("0".repeat(20)));
            stderr.emit("data", Buffer.from("FATAL"));
            callback(0, null);
          });
        }
      },
    }));

    const harness = createShellHarness({
      spawnCommand: spawnCommand as unknown as typeof import("node:child_process").spawn,
      maxOutputChars: 20,
    });

    const run = harness.runLocalShellLine("!noisy");
    harness.getLastSelector()?.onSelect?.({ value: "yes", label: "Yes" });
    await run;

    // The failure reason in stderr must survive even though stdout filled the cap;
    // the previous head-cut kept all stdout and dropped stderr entirely.
    expect(harness.messages.some((m) => m.includes("FATAL"))).toBe(true);
  });

  it("keeps a whole code point when the combined output tail starts inside an emoji", async () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const spawnCommand = vi.fn(() => ({
      stdout,
      stderr,
      on: (event: string, callback: (...args: unknown[]) => void) => {
        if (event === "close") {
          setImmediate(() => {
            stdout.emit("data", Buffer.from("x😀"));
            stderr.emit("data", Buffer.from("tail"));
            callback(0, null);
          });
        }
      },
    }));
    const harness = createShellHarness({
      spawnCommand: spawnCommand as unknown as typeof import("node:child_process").spawn,
      maxOutputChars: 6,
    });

    const run = harness.runLocalShellLine("!unicode");
    harness.getLastSelector()?.onSelect?.({ value: "yes", label: "Yes" });
    await run;

    expect(harness.messages).toContain("[local] tail");
    expect(harness.messages.join("\n")).not.toMatch(/[\uD800-\uDFFF]/u);
  });

  it("preserves UTF-8 characters split across stdout and stderr chunks", async () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const spawnCommand = vi.fn(() => ({
      stdout,
      stderr,
      on: (event: string, callback: (...args: unknown[]) => void) => {
        if (event === "close") {
          setImmediate(() => {
            const stdoutBytes = Buffer.from("猫", "utf8");
            const stderrBytes = Buffer.from("😀", "utf8");
            stdout.emit("data", stdoutBytes.subarray(0, 1));
            stderr.emit("data", stderrBytes.subarray(0, 2));
            setImmediate(() => {
              stdout.emit("data", stdoutBytes.subarray(1));
              stderr.emit("data", stderrBytes.subarray(2));
              callback(0, null);
            });
          });
        }
      },
    }));
    const harness = createShellHarness({
      spawnCommand: spawnCommand as unknown as typeof import("node:child_process").spawn,
    });

    const run = harness.runLocalShellLine("!unicode");
    harness.getLastSelector()?.onSelect?.({ value: "yes", label: "Yes" });
    await run;

    expect(harness.messages).toContain("[local] 猫");
    expect(harness.messages).toContain("[local] 😀");
    expect(harness.messages.join("\n")).not.toContain("�");
  });

  it("refuses to retarget local commands after the working directory is deleted", async () => {
    const harness = createShellHarness({ getCwd: () => undefined });

    const run = harness.runLocalShellLine("!pwd");
    harness.getLastSelector()?.onSelect?.({ value: "yes", label: "Yes" });
    await run;

    expect(harness.spawnCommand).not.toHaveBeenCalled();
    expect(harness.messages).toContain(
      "local shell: working directory was deleted; cd to an existing directory first",
    );
  });

  it("finishes a failed child before reporting the next local command", async () => {
    const harness = createShellHarness({
      spawnCommand: spawn,
      getCwd: vi
        .fn(() => process.cwd())
        .mockReturnValueOnce(join(process.cwd(), ".missing-openclaw-local-shell-directory")),
    });

    const failedRun = harness.runLocalShellLine("!echo first");
    harness.getLastSelector()?.onSelect?.({ value: "yes", label: "Yes" });
    await failedRun;
    await harness.runLocalShellLine("!echo second");

    expect(harness.messages.filter((message) => message.startsWith("[local]"))).toEqual([
      "[local] $ echo first",
      expect.stringContaining("[local] error: "),
      "[local] $ echo second",
      "[local] second",
      "[local] exit 0",
    ]);
  });

  it("does not crash when stdout or stderr emit an error event", async () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const spawnCommand = vi.fn(() => ({
      stdout,
      stderr,
      on: (event: string, callback: (...args: unknown[]) => void) => {
        if (event === "close") {
          setTimeout(() => callback(0, null), 200);
        }
      },
    }));
    const harness = createShellHarness({
      spawnCommand: spawnCommand as unknown as typeof import("node:child_process").spawn,
    });

    const run = harness.runLocalShellLine("!cmd");
    harness.getLastSelector()?.onSelect?.({ value: "yes", label: "Yes" });
    await vi.waitFor(() => expect(spawnCommand).toHaveBeenCalledTimes(1));
    stdout.emit("error", new Error("EPIPE"));
    stderr.emit("error", new Error("EIO"));

    await expect(run).resolves.toBeUndefined();
    expect(harness.messages.some((message) => message.includes("exit 0"))).toBe(true);
  });
});
