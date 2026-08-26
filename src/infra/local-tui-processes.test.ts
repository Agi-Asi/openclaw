import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listLocalTuiProcesses,
  quiesceLocalTuiProcessesBeforeUpdate,
  terminateLocalTuiProcesses,
  waitForLocalTuiUpdate,
} from "./local-tui-processes.js";

describe("local TUI processes", () => {
  afterEach(() => vi.restoreAllMocks());

  it("lists only verified local TUI processes from ps output", () => {
    const targetRoot = "/usr/lib/node_modules/openclaw";
    const spawnSync = vi.fn().mockReturnValue({
      status: 0,
      stdout: [
        " 501 101 Thu Aug 20 19:00:00 2026 /usr/local/bin/openclaw tui",
        " 501 106 Thu Aug 20 19:00:00 2026 /usr/bin/node /usr/lib/node_modules/openclaw/openclaw.mjs tui",
        " 501 107 Thu Aug 20 19:00:00 2026 /opt/other/bin/openclaw chat",
        " 501 108 Thu Aug 20 19:00:00 2026 openclaw tui",
        " 501 109 Thu Aug 20 19:00:00 2026 helper --note openclaw",
        " 501 999 Thu Aug 20 19:00:00 2026 openclaw tui",
      ].join("\n"),
    });
    vi.spyOn(fs.realpathSync, "native").mockImplementation((value) =>
      value === "/usr/local/bin/openclaw" ? `${targetRoot}/bin/openclaw` : String(value),
    );

    expect(
      listLocalTuiProcesses({
        targetRoot,
        platform: "darwin",
        currentUid: 501,
        currentPid: 999,
        spawnSync,
      }),
    ).toEqual([
      {
        pid: 101,
        command: "/usr/local/bin/openclaw tui",
        startTime: "Thu Aug 20 19:00:00 2026",
        ownership: "target",
      },
      {
        pid: 106,
        command: "/usr/bin/node /usr/lib/node_modules/openclaw/openclaw.mjs tui",
        startTime: "Thu Aug 20 19:00:00 2026",
        ownership: "target",
      },
      {
        pid: 108,
        command: "openclaw tui",
        startTime: "Thu Aug 20 19:00:00 2026",
        ownership: "ambiguous",
      },
    ]);
    expect(spawnSync).toHaveBeenCalledWith("ps", ["-axo", "uid=,pid=,lstart=,command="], {
      encoding: "utf8",
      killSignal: "SIGKILL",
      timeout: 1_000,
    });
  });

  it("lists verified TUI processes on Windows", () => {
    const spawnSync = vi.fn().mockReturnValue({
      status: 0,
      stdout: JSON.stringify([
        { ProcessId: 101, CommandLine: "C:\\openclaw.exe tui", OwnerSid: "S-1", CurrentSid: "S-1" },
        {
          ProcessId: 102,
          CommandLine: "C:\\openclaw.exe gateway",
          OwnerSid: "S-1",
          CurrentSid: "S-1",
        },
        {
          ProcessId: 103,
          CommandLine: '"C:\\Program Files\\OpenClaw\\openclaw.exe" chat',
          OwnerSid: "S-1",
          CurrentSid: "S-1",
        },
        {
          ProcessId: 104,
          CommandLine:
            '"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\OpenClaw\\openclaw.mjs" terminal',
          OwnerSid: "S-1",
          CurrentSid: "S-1",
        },
        { ProcessId: 105, CommandLine: "C:\\openclaw.exe tui", OwnerSid: "S-2", CurrentSid: "S-1" },
        { ProcessId: 106, CommandLine: "C:\\openclaw.exe tui", OwnerSid: null, CurrentSid: "S-1" },
      ]),
    });
    vi.spyOn(fs.realpathSync, "native").mockImplementation((value) => String(value));

    expect(
      listLocalTuiProcesses({
        targetRoot: "C:\\Program Files\\OpenClaw",
        platform: "win32",
        currentPid: 999,
        spawnSync,
        readWindowsStartTime: () => 123,
      }),
    ).toEqual([
      {
        pid: 103,
        command: '"C:\\Program Files\\OpenClaw\\openclaw.exe" chat',
        startTime: "123",
        ownership: "target",
      },
      {
        pid: 104,
        command:
          '"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\OpenClaw\\openclaw.mjs" terminal',
        startTime: "123",
        ownership: "target",
      },
    ]);
    expect(spawnSync).toHaveBeenCalledOnce();
  });

  it("terminates stale local TUI processes with a kill fallback", async () => {
    const alive = new Set([101]);
    const signals: Array<[number, string | number]> = [];
    const controller = {
      kill: vi.fn((pid: number, signal: string | number) => {
        signals.push([pid, signal]);
        if (signal === "SIGKILL") {
          alive.delete(pid);
          return true;
        }
        if (signal === 0) {
          if (alive.has(pid)) {
            return true;
          }
          throw Object.assign(new Error("gone"), { code: "ESRCH" });
        }
        return true;
      }),
    };

    await expect(
      terminateLocalTuiProcesses({
        processes: [{ pid: 101, command: "openclaw-tui", startTime: "start", ownership: "target" }],
        controller,
        graceMs: 0,
        killGraceMs: 0,
        readStartTime: () => "start",
      }),
    ).resolves.toEqual({ stopped: [101], failed: [] });
    expect(signals).toEqual([
      [101, "SIGTERM"],
      [101, 0],
      [101, "SIGKILL"],
      [101, 0],
    ]);
  });

  it("reports local TUI processes that survive the kill fallback", async () => {
    const controller = {
      kill: vi.fn(() => true),
    };

    await expect(
      terminateLocalTuiProcesses({
        processes: [{ pid: 101, command: "openclaw-tui", startTime: "start", ownership: "target" }],
        controller,
        graceMs: 0,
        killGraceMs: 0,
        readStartTime: () => "start",
      }),
    ).resolves.toEqual({ stopped: [], failed: [101] });
  });

  it("fails closed when a live process identity can no longer be read", async () => {
    const controller = { kill: vi.fn(() => true) };
    let reads = 0;

    await expect(
      terminateLocalTuiProcesses({
        processes: [{ pid: 101, command: "openclaw-tui", startTime: "start", ownership: "target" }],
        controller,
        graceMs: 0,
        killGraceMs: 0,
        readStartTime: () => (++reads === 1 ? "start" : undefined),
      }),
    ).resolves.toEqual({ stopped: [], failed: [101] });
    expect(controller.kill).not.toHaveBeenCalledWith(101, "SIGKILL");
  });

  it("refuses shared update mutation when a matched client survives", async () => {
    const processes = [{ pid: 101, command: "/target/openclaw tui", ownership: "target" as const }];

    await expect(
      quiesceLocalTuiProcessesBeforeUpdate("/target", {
        list: () => processes,
        terminate: async () => ({ stopped: [], failed: [101] }),
      }),
    ).rejects.toThrow(
      "Update refused: could not stop local TUI clients 101. Close them and retry the update.",
    );
  });

  it("holds the startup gate after discovery until the update owner releases it", async () => {
    const release = vi.fn(async () => {});
    const lock = await quiesceLocalTuiProcessesBeforeUpdate("/target", {
      list: () => [],
      acquireLock: vi.fn(async () => ({ lockPath: "test", release })),
    });

    expect(release).not.toHaveBeenCalled();
    expect(lock?.stopped).toEqual([]);
    await lock?.release();
    expect(release).toHaveBeenCalledOnce();
  });

  it("returns stopped clients to the update owner", async () => {
    const release = vi.fn(async () => {});
    const gate = await quiesceLocalTuiProcessesBeforeUpdate("/target", {
      list: () => [{ pid: 101, command: "/target/openclaw tui", ownership: "target" }],
      terminate: async () => ({ stopped: [101], failed: [] }),
      acquireLock: vi.fn(async () => ({ lockPath: "test", release })),
    });

    expect(gate?.stopped).toEqual([101]);
    await gate?.release();
  });

  it("refuses mutation before signaling an ambiguous TUI", async () => {
    const terminate = vi.fn();
    await expect(
      quiesceLocalTuiProcessesBeforeUpdate("/target", {
        list: () => [{ pid: 101, command: "openclaw tui", ownership: "ambiguous" }],
        terminate,
      }),
    ).rejects.toThrow("could not bind local TUI clients 101 to this installation");
    expect(terminate).not.toHaveBeenCalled();
  });

  it("waits for the update gate before TUI startup", async () => {
    const release = vi.fn(async () => {});
    await waitForLocalTuiUpdate(vi.fn(async () => ({ lockPath: "test", release })));
    expect(release).toHaveBeenCalledOnce();
  });

  it("keeps waiting after the bounded lock attempt while an update is still running", async () => {
    const release = vi.fn(async () => {});
    const timeout = Object.assign(new Error("busy"), { code: "file_lock_timeout" });
    const acquireLock = vi
      .fn()
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce({ lockPath: "test", release });

    await waitForLocalTuiUpdate(acquireLock);

    expect(acquireLock).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledOnce();
  });
});
