// Verifies chat-facing CLI snippets execute the OpenClaw CLI even from harness-hosted gateways.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { prepareSystemRunMutableFileBinding } from "../../infra/system-run-approval-binding.js";
import {
  buildCurrentOpenClawCliArgv,
  buildCurrentOpenClawCliCommand,
  buildCurrentOpenClawCliExecEnv,
} from "./commands-openclaw-cli.js";

describe("buildCurrentOpenClawCliArgv", () => {
  it("delegates launch policy while keeping shell rendering local", () => {
    const args = ["sessions", "export-trajectory"];
    const argv = buildCurrentOpenClawCliArgv(args);
    expect(argv.at(-2)).toBe("sessions");
    expect(argv.at(-1)).toBe("export-trajectory");
    expect(buildCurrentOpenClawCliCommand(args)).toBe(argv.map((value) => `'${value}'`).join(" "));
  });

  it.runIf(process.platform !== "win32")(
    "keeps checkout CLI commands approval-bindable",
    async () => {
      const command = buildCurrentOpenClawCliCommand(["sessions", "export-trajectory"]);
      const prepared = await prepareSystemRunMutableFileBinding({
        command: { kind: "shell", text: command },
        cwd: process.cwd(),
      });

      expect(prepared.ok).toBe(true);
      if (!prepared.ok) {
        return;
      }
      expect(prepared.binding.operands).toHaveLength(1);
      expect(path.basename(prepared.binding.operands[0]?.snapshot.path ?? "")).toBe(
        "openclaw.mjs",
      );
    },
  );

  it("clears inherited Vitest runner environment for CLI child processes", () => {
    expect(
      buildCurrentOpenClawCliExecEnv({
        PATH: "/usr/bin",
        VITEST: "true",
        VITEST_POOL_ID: "pool",
        OPENCLAW_VITEST_MAX_WORKERS: "1",
      }),
    ).toEqual({
      VITEST: "",
      VITEST_POOL_ID: "",
      OPENCLAW_VITEST_MAX_WORKERS: "",
    });
  });
});
