import type { SessionEntry } from "../config/sessions.js";

export type AgentRuntimeSessionSpawnContext = {
  completionOwnerSessionKey?: string;
  inheritedToolPolicy: {
    version: 1;
    allow: string[];
    deny: string[];
  };
  initialSpawnEntry?: Pick<
    SessionEntry,
    | "completionOwnerSessionKey"
    | "fastMode"
    | "inheritedToolAllow"
    | "inheritedToolDeny"
    | "inheritedToolPolicyVersion"
    | "model"
    | "modelOverride"
    | "modelOverrideFallbackOriginModel"
    | "modelOverrideFallbackOriginProvider"
    | "modelOverrideRouteResolution"
    | "modelOverrideSource"
    | "modelProvider"
    | "providerOverride"
    | "subagentControlScope"
    | "subagentRole"
    | "swarmCollector"
    | "swarmGroupId"
    | "swarmOutputSchema"
    | "thinkingLevel"
  > & { spawnedWorkspaceDir?: string; spawnedCwd?: string };
};
