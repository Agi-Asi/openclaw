import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = "scripts/mantis/bake-telegram-desktop-image.sh";

describe("Mantis Telegram Desktop image bake", () => {
  it("pins Telegram and proves explicit, promoted, and unchanged-default selection", () => {
    const script = readFileSync(SCRIPT, "utf8");

    expect(script).toContain('telegram_version="7.0.9"');
    expect(script).toContain(
      'telegram_url="https://github.com/telegramdesktop/tdesktop/releases/download/v7.0.9/tsetup.7.0.9.tar.xz"',
    );
    expect(script).toContain(
      'telegram_sha256="d3c05df0259ab116d11d8c1cdc1403019d2a3be303ad3b46d16a84e19df6615f"',
    );
    expect(script).toContain('--catalog-only --variant-sdk "$variant_sdk"');
    expect(script).toContain('args+=(--image-sdk "$image_selector")');
    expect(script).toContain('assert_selected_image "$log_dir/variant.log" "$ami_id" promoted');
    expect(script).toContain('if [[ "$default_image" == "$ami_id" ]]');
    expect(script).toContain("Crabbox coordinator admin is required with --run");
    expect(script).toContain(
      "Could not verify Crabbox coordinator admin access; refusing to start paid leases",
    );
    expect(script).not.toContain("ADMIN_TOKEN is required");
  });

  it("proves the image contract the way the recorder asserts it", () => {
    const script = readFileSync(SCRIPT, "utf8");

    // The marker lives with the app: Crabbox's state dir is not traversable by
    // the lease user on AWS desktop images.
    expect(script).toContain("marker=/opt/Telegram/openclaw-image-version");
    expect(script).not.toContain("/var/lib/crabbox/telegram-desktop-version");
    // setsid execs in place, so the launcher tracks its pid instead of matching
    // by process name, which misses the fork-to-exec window on a cold binary.
    expect(script).toContain("setsid /opt/Telegram/Telegram");
    expect(script).toContain('kill -0 "$telegram_pid"');
    // A login shell runs ~/.bash_logout, whose clear_console failure replaces the
    // script's exit status, so remote payloads are uploaded, never inlined.
    expect(script).toContain("--no-sync --script");
    expect(script).not.toContain("--no-sync --shell");
  });

  it("runs prep-only without an image, a promotion, or coordinator admin", () => {
    const script = readFileSync(SCRIPT, "utf8");

    expect(script).toContain("--prep-only");
    expect(script).toContain('if [[ "$prep_only" == "1" ]]; then\n  admin_probe="not found"');
    expect(script).toContain("prep-only run passed");
    expect(script).toContain("imageCreated: false");
  });

  it("parses as Bash and performs no Crabbox work without --run", () => {
    const syntax = spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" });
    expect(syntax.stderr).toBe("");
    expect(syntax.status).toBe(0);

    const tempRoot = mkdtempSync(path.join(tmpdir(), "telegram-image-dry-run-"));
    try {
      const crabbox = path.join(tempRoot, "crabbox");
      const marker = path.join(tempRoot, "called");
      writeFileSync(crabbox, `#!/usr/bin/env bash\nprintf called >${JSON.stringify(marker)}\n`);
      chmodSync(crabbox, 0o755);
      const dryRun = spawnSync("bash", [SCRIPT, "--crabbox-bin", crabbox], {
        encoding: "utf8",
      });

      expect(dryRun.status).toBe(0);
      expect(dryRun.stdout).toContain("dry plan only");
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true });
    }
  });
});
