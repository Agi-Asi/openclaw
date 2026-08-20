// Preaction parser coverage for invocation-scoped state migration ownership.
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDoctorConfigSnapshot } from "../../commands/doctor-config-snapshot.test-helpers.js";
import { resolveStateMigrationConfigInput } from "../../commands/doctor/shared/legacy-config-state-migration-input.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  ensureConfigReady: vi.fn<(options: { stateMigrationAgentId?: string }) => Promise<void>>(),
}));

vi.mock("../../globals.js", () => ({ setVerbose: vi.fn() }));
vi.mock("../../runtime.js", () => ({
  defaultRuntime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() },
}));
vi.mock("../../logging/console.js", () => ({ routeLogsToStderr: vi.fn() }));
vi.mock("../banner.js", () => ({ emitCliBanner: vi.fn() }));
vi.mock("../cli-name.js", () => ({ resolveCliName: () => "openclaw" }));
vi.mock("./config-guard.js", () => ({ ensureConfigReady: mocks.ensureConfigReady }));
vi.mock("../plugin-registry.js", () => ({ ensurePluginRegistryLoaded: vi.fn() }));

const originalArgv = [...process.argv];
const originalTitle = process.title;

function createProgram(): Command {
  const program = new Command().name("openclaw").enablePositionalOptions();
  const models = program.command("models").option("--agent <id>");
  const auth = models.command("auth").option("--agent <id>");
  auth
    .command("setup-token")
    .option("--agent <id>")
    .action(() => {});
  return program;
}

describe("preaction migration agent owner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.title = originalTitle;
  });

  it.each([
    ["leaf", ["models", "auth", "setup-token", "--agent", "main"], "main"],
    ["parent", ["models", "auth", "--agent", "main", "setup-token"], "main"],
    ["grandparent", ["models", "--agent", "main", "auth", "setup-token"], "main"],
    [
      "leaf over parent",
      ["models", "auth", "--agent", "main", "setup-token", "--agent", "work"],
      "work",
    ],
    ["omitted", ["models", "auth", "setup-token"], undefined],
    ["unknown", ["models", "auth", "setup-token", "--agent", "missing"], undefined],
    ["invalid", ["models", "auth", "setup-token", "--agent", "main!"], undefined],
  ])(
    "uses only a valid explicit migration owner from the %s placement",
    async (_label, argv, expected) => {
      const config = {
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "ambient" } },
          entries: { ambient: {}, main: {}, work: {} },
        },
      } satisfies OpenClawConfig;
      let migrationOwner: string | undefined;
      mocks.ensureConfigReady.mockImplementationOnce(async (options) => {
        const snapshot = createDoctorConfigSnapshot({ config });
        migrationOwner = resolveStateMigrationConfigInput({
          snapshot,
          baseConfig: snapshot.sourceConfig,
          stateMigrationAgentId: options.stateMigrationAgentId,
        })?.cfg?.agents?.defaults?.systemAgent?.agentId;
      });
      const program = createProgram();
      const { registerPreActionHooks } = await import("./preaction.js");
      registerPreActionHooks(program, "test");
      process.argv = ["node", "openclaw", ...argv];

      await program.parseAsync(process.argv);

      expect(migrationOwner).toBe(expected ?? "ambient");
      expect(config.agents.defaults.systemAgent.agentId).toBe("ambient");
    },
  );
});
