// Private helper surface for the bundled Codex plugin. Mirrors the Codex CLI
// runtime's user-mcp-server projection so the bundled Codex app-server harness
// can attach the same user `mcp.servers` entries to its thread config without
// deep-importing core helpers.
import {
  captureCronScheduledToolAuthority,
  pinExecToolTarget,
} from "../agents/exec-tool-target-pinning.js";
import type { AgentHarnessHostCapabilities } from "../agents/harness/host-capability-types.js";
import {
  resolveAgentHarnessScheduledToolProjectionCapability,
  type AgentHarnessScheduledToolProjectionFactory,
} from "../agents/harness/host-private-capabilities.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type {
  CronCreatorToolAllowlistEntry,
  CronToolsAllowCaptureRef,
} from "../agents/tools/cron-tool.types.js";

export { pinExecToolTarget };
export type CodexScheduledToolProjectionFactory = AgentHarnessScheduledToolProjectionFactory;
export {
  buildCodexUserMcpServersThreadConfigPatch,
  buildCodexUserMcpServersThreadConfigPatchForRuntime,
  resolveCodexMcpToolOverridesForAgent,
} from "../agents/cli-runner/bundle-mcp-codex.js";
export {
  runWithCronCreatorAuthorityCapabilityResolver,
  runWithCronCreatorAuthorityResolver,
} from "../agents/cron-creator-authority-context.js";

/** Resolve the private scheduled-tool issuer for the registered Codex harness owner. */
export function resolveCodexScheduledToolProjectionFactory(
  hostCapabilities: AgentHarnessHostCapabilities,
): CodexScheduledToolProjectionFactory | undefined {
  return resolveAgentHarnessScheduledToolProjectionCapability({
    hostCapabilities,
    ownerPluginId: "codex",
  });
}

/** Materialize static configured MCP under a scheduled Codex authority envelope. */
export async function materializeStaticMcpToolsForScheduledHarnessRun(
  params: Parameters<
    typeof import("../agents/agent-bundle-mcp-harness.js").materializeStaticMcpToolsForScheduledHarnessRunCore
  >[0],
) {
  const { materializeStaticMcpToolsForScheduledHarnessRunCore: materialize } =
    await import("../agents/agent-bundle-mcp-harness.js");
  return materialize(params);
}

/** Capture the final Codex dynamic-tool surface for cron creator authority. */
export async function captureFinalCodexCronCreatorToolAllowlist(
  target: CronCreatorToolAllowlistEntry[],
  captureRef: CronToolsAllowCaptureRef,
  tools: readonly AnyAgentTool[],
) {
  const [{ captureFinalEffectiveCronCreatorToolAllowlist: capture }, { getPluginToolMeta }] =
    await Promise.all([import("../agents/tools/cron-tool.js"), import("../plugins/tools.js")]);
  capture(target, captureRef, tools, (tool) => getPluginToolMeta(tool));
  return captureCronScheduledToolAuthority(tools, {
    version: 1,
    runtimeId: "codex",
    namespace: "scheduled-tools",
    payload: { version: 1 },
  });
}
