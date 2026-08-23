#!/usr/bin/env -S pnpm tsx
// Temporary exact-revision live proof for PR #128350. This file is never merged.
import { appendFileSync, existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";
import { sleep as delay } from "../lib/sleep.mjs";
import { run, runStreaming, say, shellQuote } from "./parallels/host-command.ts";
import { startNpmRegistryServer } from "./parallels/host-server.ts";
import { packOpenClaw, packageVersionFromTgz } from "./parallels/package-artifact.ts";
import type { NpmRegistryServer } from "./parallels/types.ts";

const gatewayLabel = "ai.openclaw.gateway";
const gatewayPort = 18789;
const productHead = "572e70efe734c533443a90ef698000a1375e578f";
const proofScriptPath = "scripts/e2e/macos-app-bootstrap-ci.ts";

type CommandOptions = {
  check?: boolean;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

function safeText(value: string): string {
  return redactSensitiveText(value);
}

function requireSafeRunner(input: {
  allowReset?: string;
  ci?: string;
  home: string;
  platform: NodeJS.Platform;
}): void {
  if (input.platform !== "darwin") {
    throw new Error("live macOS proof requires a Darwin runner");
  }
  if (input.ci !== "true" || input.allowReset !== "1") {
    throw new Error("refusing to reset user state outside explicit CI");
  }
  const resolvedHome = path.resolve(input.home);
  if (!resolvedHome.startsWith("/Users/") || resolvedHome.split(path.sep).length !== 3) {
    throw new Error(`refusing unsafe CI home: ${resolvedHome}`);
  }
}

class LiveProof {
  private readonly artifactDir = path.resolve(
    process.env.OPENCLAW_PROOF_ARTIFACT_DIR ?? ".artifacts/macos-app-bootstrap",
  );
  private readonly commandLog = path.join(this.artifactDir, "commands.log");
  private readonly home = homedir();
  private readonly launchAgentPath = path.join(
    this.home,
    "Library/LaunchAgents",
    `${gatewayLabel}.plist`,
  );
  private readonly stateDir = path.join(this.home, ".openclaw");
  private readonly uid = process.getuid?.();
  private readonly variant = "candidate";
  private appPath = "";
  private bundleId = "";
  private candidateVersion = "";
  private registryServer: NpmRegistryServer | null = null;
  private tempRoot = "";

  async run(): Promise<void> {
    requireSafeRunner({
      allowReset: process.env.OPENCLAW_E2E_ALLOW_HOME_RESET,
      ci: process.env.CI,
      home: this.home,
      platform: process.platform,
    });
    if (this.uid == null) throw new Error("cannot resolve current macOS user id");
    await mkdir(this.artifactDir, { recursive: true });
    this.tempRoot = await mkdtemp(path.join(tmpdir(), "pr128350-macos-live."));

    try {
      await this.preflight();
      await this.prepareCandidate();
      await this.launchAndNavigate();
      const uiDump = await this.waitForFailedServiceState();
      await writeFile(path.join(this.artifactDir, "ui-tree.txt"), safeText(uiDump));
      const screenshot = await this.captureWindow();
      await this.captureDiagnostics("final");
      await writeFile(
        path.join(this.artifactDir, "summary.json"),
        `${JSON.stringify(
          {
            appBundleId: this.bundleId,
            candidateVersion: this.candidateVersion,
            artifactExportRequiresNonzeroExit: true,
            gatewayFailureObserved: true,
            managedCLI: path.join(this.stateDir, "bin/openclaw"),
            productHead,
            proofHead: this.runLogged("/usr/bin/git", ["rev-parse", "HEAD"]).stdout.trim(),
            screenshot,
            variant: this.variant,
          },
          null,
          2,
        )}\n`,
      );
      say(`Live macOS onboarding failure state captured for ${this.variant}`);
      // The already-published historical workflow uploads this directory only after a failed
      // step. Exit nonzero after recording a passing summary so the screenshot can be retrieved;
      // this manual proof run is deliberately not attached to the PR's required CI checks.
      process.stderr.write("[proof-export] capture complete; requesting artifact upload\n");
      process.exitCode = 86;
    } catch (error) {
      await writeFile(
        path.join(this.artifactDir, "failure.log"),
        `${safeText(error instanceof Error ? (error.stack ?? error.message) : String(error))}\n`,
      ).catch(() => undefined);
      await this.captureDiagnostics("failure").catch(() => undefined);
      await this.captureWindow("failure.png").catch(() => undefined);
      throw error;
    } finally {
      await this.cleanup().catch((error: unknown) => {
        process.stderr.write(`cleanup warning: ${String(error)}\n`);
      });
      await this.registryServer?.stop().catch(() => undefined);
      if (this.tempRoot) await rm(this.tempRoot, { force: true, recursive: true });
    }
  }

  private async preflight(): Promise<void> {
    const actualHead = this.runLogged("/usr/bin/git", ["rev-parse", "HEAD"]).stdout.trim();
    this.runLogged("/usr/bin/git", ["fetch", "--no-tags", "--deepen=1", "origin", actualHead], {
      timeoutMs: 120_000,
    });
    const actualParent = this.runLogged("/usr/bin/git", ["rev-parse", "HEAD^"]).stdout.trim();
    if (actualParent !== productHead) {
      throw new Error(`proof head parent is ${actualParent}; expected product head ${productHead}`);
    }
    const proofChanges = this.runLogged("/usr/bin/git", [
      "diff",
      "--name-only",
      `${productHead}..${actualHead}`,
    ]).stdout.trim();
    if (proofChanges !== proofScriptPath) {
      throw new Error(`proof commit changed unexpected product paths: ${proofChanges}`);
    }
    // The workflow injects this harness after checking out the immutable product SHA. Remove it
    // once Node has loaded the module so package/build inputs are byte-for-byte the target tree.
    await rm(fileURLToPath(import.meta.url), { force: true });
    const productDiff = this.runStatus("/usr/bin/git", ["diff", "--quiet", productHead, "--", "."]);
    if (productDiff !== 0) {
      throw new Error("working product tree differs from the exact PR head before packaging");
    }
    this.runLogged("/bin/launchctl", ["print", `gui/${this.uid}`], { timeoutMs: 30_000 });
    this.runLogged("/usr/bin/stat", ["-f", "console-user=%Su", "/dev/console"]);
    this.runLogged("/usr/bin/osascript", [
      "-e",
      'tell application "System Events" to get name of first process whose frontmost is true',
    ]);
    await this.cleanup();
  }

  private async prepareCandidate(): Promise<void> {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      version?: unknown;
    };
    if (typeof packageJson.version !== "string" || !packageJson.version.trim()) {
      throw new Error("package.json does not contain a version");
    }
    this.candidateVersion = packageJson.version.trim();

    say(`Pack exact product revision ${productHead}`);
    const packageDir = path.join(this.tempRoot, "package");
    const artifact = await packOpenClaw({ destination: packageDir, requireControlUi: true });
    const packedVersion = await packageVersionFromTgz(artifact.path);
    if (packedVersion !== this.candidateVersion) {
      throw new Error(`packed version ${packedVersion}; expected ${this.candidateVersion}`);
    }
    this.registryServer = await startNpmRegistryServer({
      hostIp: "127.0.0.1",
      packages: [{ name: "openclaw", tarballPath: artifact.path, version: packedVersion }],
    });

    say("Install the exact candidate CLI as a user would");
    const installStatus = await runStreaming(
      "/bin/bash",
      [
        "scripts/install-cli.sh",
        "--json",
        "--no-onboard",
        "--prefix",
        this.stateDir,
        "--version",
        this.candidateVersion,
      ],
      {
        env: {
          ...process.env,
          NPM_CONFIG_REGISTRY: this.registryServer.hostUrl,
          npm_config_registry: this.registryServer.hostUrl,
        },
        logPath: path.join(this.artifactDir, "install-cli.log"),
        timeoutMs: 15 * 60_000,
      },
    );
    if (installStatus !== 0) throw new Error(`candidate CLI install failed with ${installStatus}`);
    const managedCLI = path.join(this.stateDir, "bin/openclaw");
    const installedVersion = this.runLogged(managedCLI, ["--version"], {
      timeoutMs: 30_000,
    }).stdout.trim();
    if (!installedVersion.includes(this.candidateVersion)) {
      throw new Error(
        `installed CLI version ${installedVersion}; expected ${this.candidateVersion}`,
      );
    }

    this.appPath = path.resolve("dist/pr128350-live/OpenClaw.app");
    say(`Build and sign packaged debug app ${this.candidateVersion}`);
    const packageStatus = await runStreaming("/bin/bash", ["scripts/package-mac-app.sh"], {
      env: {
        ...process.env,
        ALLOW_ADHOC_SIGNING: "1",
        APP_VERSION: this.candidateVersion,
        BUILD_CONFIG: "debug",
        OPENCLAW_PACKAGE_APP_ROOT: this.appPath,
        SIGN_IDENTITY: "-",
        SKIP_PNPM_INSTALL: "1",
        SKIP_TSC: "1",
        SKIP_UI_BUILD: "1",
      },
      logPath: path.join(this.artifactDir, "package-mac-app.log"),
      timeoutMs: 30 * 60_000,
    });
    if (packageStatus !== 0) throw new Error(`package-mac-app failed with ${packageStatus}`);
    this.bundleId = this.runLogged("/usr/libexec/PlistBuddy", [
      "-c",
      "Print :CFBundleIdentifier",
      path.join(this.appPath, "Contents/Info.plist"),
    ]).stdout.trim();

    const wrapperPath = path.join(this.tempRoot, "gateway-fails-after-cli-install.sh");
    await writeFile(
      wrapperPath,
      `#!/bin/sh\nprintf '%s\\n' "wrapper invoked: expected activation failure" >> ${shellQuote(path.join(this.artifactDir, "gateway-wrapper.log"))}\nexit 42\n`,
    );
    await chmod(wrapperPath, 0o700);
    for (const [key, value] of [
      ["OPENCLAW_WRAPPER", wrapperPath],
      ["OPENCLAW_LOG_DIR", path.join(this.artifactDir, "app-logs")],
    ] as const) {
      this.runLogged("/bin/launchctl", ["setenv", key, value]);
    }

    for (const [key, type, value] of [
      ["openclaw.onboardingSeen", "-bool", "false"],
      ["openclaw.onboardingVersion", "-int", "0"],
      // Start from the true first-run state so onboarding is presented before
      // ConnectionModeCoordinator waits on the intentionally failing Gateway.
      ["openclaw.connectionMode", "-string", "unconfigured"],
      ["openclaw.pauseEnabled", "-bool", "false"],
      ["openclaw.showDockIcon", "-bool", "true"],
      ["openclaw.debug.fileLogEnabled", "-bool", "true"],
      ["openclaw.debug.appLogLevel", "-string", "debug"],
    ] as const) {
      this.runLogged("/usr/bin/defaults", ["write", this.bundleId, key, type, value]);
    }
  }

  private async launchAndNavigate(): Promise<void> {
    this.runLogged("/usr/bin/open", ["-n", this.appPath], { timeoutMs: 30_000 });
    await this.waitFor(
      "OpenClaw process",
      30_000,
      () => this.runStatus("/usr/bin/pgrep", ["-x", "OpenClaw"]) === 0,
    );
    await this.waitFor("onboarding window", 45_000, () => this.windowExists());
    await this.waitForUI("Welcome to OpenClaw", 45_000);
    await this.clickNext();
    await this.waitForUI("Where should your assistant live?", 30_000);
    await this.clickNext();
    await this.waitForUI("Install OpenClaw", 30_000);
  }

  private async waitForFailedServiceState(): Promise<string> {
    let latest = "";
    await this.waitFor("Gateway activation failure in onboarding UI", 180_000, async () => {
      latest = await this.uiDump();
      return latest.toLowerCase().includes("gateway did not start");
    });
    if (!latest.includes("Install OpenClaw")) {
      throw new Error("final UI does not contain the Install OpenClaw row");
    }
    if (!latest.includes("Start the background service")) {
      throw new Error("final UI does not contain the background service row");
    }
    if (!existsSync(path.join(this.stateDir, "bin/openclaw"))) {
      throw new Error("managed CLI disappeared before capture");
    }
    if (!existsSync(path.join(this.artifactDir, "gateway-wrapper.log"))) {
      throw new Error("failing Gateway wrapper was never invoked");
    }
    return latest;
  }

  private async clickNext(): Promise<void> {
    const script = `
tell application "OpenClaw" to activate
delay 0.5
tell application "System Events"
  tell process "OpenClaw"
    set frontmost to true
    try
      click button "Next" of window 1
    on error
      key code 36
    end try
  end tell
end tell`;
    this.runLogged("/usr/bin/osascript", ["-e", script], { timeoutMs: 30_000 });
    await delay(1_000);
  }

  private async waitForUI(text: string, timeoutMs: number): Promise<void> {
    await this.waitFor(`UI text ${JSON.stringify(text)}`, timeoutMs, async () =>
      (await this.uiDump()).includes(text),
    );
  }

  private windowExists(): boolean {
    const result = this.runLogged(
      "/usr/bin/osascript",
      [
        "-e",
        'tell application "System Events" to tell process "OpenClaw" to return exists window 1',
      ],
      { check: false, timeoutMs: 15_000 },
    );
    return result.status === 0 && result.stdout.trim() === "true";
  }

  private async uiDump(): Promise<string> {
    const script = `
tell application "System Events"
  tell process "OpenClaw"
    set frontmost to true
    if not (exists window 1) then error "OpenClaw window is missing"
    set output to ""
    repeat with itemRef in (entire contents of window 1)
      set roleText to ""
      set titleText to ""
      set valueText to ""
      try
        set roleText to role of itemRef as text
      end try
      try
        set titleText to title of itemRef as text
      end try
      try
        set valueText to value of itemRef as text
      end try
      if roleText is not "" or titleText is not "" or valueText is not "" then
        set output to output & roleText & tab & titleText & tab & valueText & linefeed
      end if
    end repeat
    return output
  end tell
end tell`;
    const result = this.runLogged("/usr/bin/osascript", ["-e", script], {
      check: false,
      timeoutMs: 30_000,
    });
    if (result.status !== 0) {
      throw new Error(`cannot inspect live OpenClaw UI: ${result.stderr.trim()}`);
    }
    return result.stdout;
  }

  private async captureWindow(fileName = "onboarding-state.png"): Promise<string> {
    if (!this.windowExists()) throw new Error("cannot capture missing OpenClaw window");
    const boundsScript = `
tell application "System Events"
  tell process "OpenClaw"
    set p to position of window 1
    set s to size of window 1
    return (item 1 of p as text) & "," & (item 2 of p as text) & "," & (item 1 of s as text) & "," & (item 2 of s as text)
  end tell
end tell`;
    const bounds = this.runLogged("/usr/bin/osascript", ["-e", boundsScript], {
      timeoutMs: 30_000,
    }).stdout.trim();
    if (!/^\d+,\d+,\d+,\d+$/u.test(bounds)) {
      throw new Error(`invalid OpenClaw window bounds: ${bounds}`);
    }
    const output = path.join(this.artifactDir, fileName);
    this.runLogged("/usr/sbin/screencapture", ["-x", `-R${bounds}`, output], {
      timeoutMs: 30_000,
    });
    if (!existsSync(output)) throw new Error(`screenshot was not created: ${output}`);
    this.runLogged("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", output]);
    return path.relative(process.cwd(), output);
  }

  private async captureDiagnostics(label: string): Promise<void> {
    const sections: string[] = [];
    const capture = (title: string, command: string, args: string[]): void => {
      const result = run(command, args, { check: false, quiet: true, timeoutMs: 30_000 });
      sections.push(`## ${title}\nexit=${result.status}\n${result.stdout}${result.stderr}`);
    };
    capture("console user", "/usr/bin/stat", ["-f", "%Su", "/dev/console"]);
    capture("processes", "/usr/bin/pgrep", ["-alf", "OpenClaw|openclaw|install-cli"]);
    capture("Gateway LaunchAgent", "/bin/launchctl", ["print", `gui/${this.uid}/${gatewayLabel}`]);
    capture("app unified log", "/usr/bin/log", [
      "show",
      "--info",
      "--last",
      "15m",
      "--style",
      "compact",
      "--predicate",
      'subsystem == "ai.openclaw"',
    ]);
    await writeFile(
      path.join(this.artifactDir, `diagnostics-${label}.log`),
      safeText(sections.join("\n\n")),
    );
  }

  private async cleanup(): Promise<void> {
    if (this.uid == null) return;
    this.runLogged("/usr/bin/pkill", ["-x", "OpenClaw"], { check: false });
    this.runLogged("/usr/bin/pkill", ["-f", "Contents/Resources/[i]nstall-cli.sh"], {
      check: false,
    });
    this.runLogged("/bin/launchctl", ["bootout", `gui/${this.uid}/${gatewayLabel}`], {
      check: false,
      timeoutMs: 30_000,
    });
    for (const key of ["OPENCLAW_WRAPPER", "OPENCLAW_LOG_DIR"]) {
      this.runLogged("/bin/launchctl", ["unsetenv", key], { check: false });
    }
    await rm(this.launchAgentPath, { force: true });
    await rm(this.stateDir, { force: true, recursive: true });
    for (const id of [this.bundleId, "ai.openclaw.mac.debug", "ai.openclaw.mac"])
      if (id) this.runLogged("/usr/bin/defaults", ["delete", id], { check: false });
  }

  private async waitFor(
    description: string,
    timeoutMs: number,
    predicate: () => boolean | Promise<boolean>,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await delay(2_000);
    }
    throw new Error(`timed out waiting for ${description}`);
  }

  private runLogged(command: string, args: string[], options: CommandOptions = {}) {
    const result = run(command, args, {
      check: false,
      env: options.env,
      quiet: true,
      timeoutMs: options.timeoutMs,
    });
    appendFileSync(
      this.commandLog,
      safeText(
        `$ ${[command, ...args].join(" ")}\nexit=${result.status}\n${result.stdout}${result.stderr}\n`,
      ),
      "utf8",
    );
    if (options.check !== false && result.status !== 0) {
      throw new Error(`command failed (${result.status}): ${command} ${args.join(" ")}`);
    }
    return result;
  }

  private runStatus(command: string, args: string[]): number {
    return run(command, args, { check: false, quiet: true, timeoutMs: 15_000 }).status;
  }
}

await new LiveProof().run().catch((error: unknown) => {
  process.stderr.write(`PR #128350 live proof failed: ${safeText(String(error))}\n`);
  process.stderr.write("[pr128350-macos-live-proof] FAILED (exit 1)\n");
  process.exitCode = 1;
});
