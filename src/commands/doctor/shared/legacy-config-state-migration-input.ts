import { isValidAgentId, normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { listAgentIds } from "../../../agents/agent-scope-config.js";
import { copyConfigResolutionFacts } from "../../../config/resolution-facts.js";
import type { ConfigFileSnapshot } from "../../../config/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { migrateLegacyConfig } from "./legacy-config-migrate.js";

type StateMigrationConfigInput = {
  cfg?: OpenClawConfig;
  pluginDoctorConfig?: OpenClawConfig;
};

export function resolveStateMigrationConfigInput(params: {
  snapshot: ConfigFileSnapshot;
  baseConfig: OpenClawConfig;
  stateMigrationAgentId?: string;
}): StateMigrationConfigInput | null {
  const pluginDoctorConfig = (params.snapshot.sourceConfig ??
    params.snapshot.config ??
    params.snapshot.parsed) as OpenClawConfig | undefined;
  let input: StateMigrationConfigInput;
  if (params.snapshot.valid) {
    input =
      params.snapshot.legacyIssues.length > 0 && pluginDoctorConfig !== undefined
        ? { cfg: params.baseConfig, pluginDoctorConfig }
        : { cfg: params.baseConfig };
  } else {
    const migrationSource = pluginDoctorConfig ?? params.snapshot.parsed;
    if (params.snapshot.legacyIssues.length === 0 || migrationSource === undefined) {
      return null;
    }
    const migrated = migrateLegacyConfig(migrationSource);
    if (!migrated.config) {
      return null;
    }
    input = migrated.partiallyValid
      ? { pluginDoctorConfig: (pluginDoctorConfig ?? migrationSource) as OpenClawConfig }
      : {
          cfg: migrated.config,
          ...(pluginDoctorConfig ? { pluginDoctorConfig } : {}),
        };
  }

  const requestedAgentId = params.stateMigrationAgentId?.trim();
  if (!input.cfg || !requestedAgentId || !isValidAgentId(requestedAgentId)) {
    return input;
  }
  const agentId = normalizeAgentId(requestedAgentId);
  if (!listAgentIds(params.snapshot.sourceConfig).includes(agentId)) {
    return input;
  }

  // An explicit CLI --agent owns this invocation's migration, overriding its ambient owner.
  // Clone only the migration input so the configured owner can never leak into persisted writes.
  const migrationConfig: OpenClawConfig = {
    ...input.cfg,
    agents: {
      ...input.cfg.agents,
      defaults: {
        ...input.cfg.agents?.defaults,
        systemAgent: { ...input.cfg.agents?.defaults?.systemAgent, agentId },
      },
    },
  };
  copyConfigResolutionFacts(input.cfg, migrationConfig);
  return { ...input, cfg: migrationConfig };
}
