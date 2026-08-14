import type { SessionPermissionMode } from "../../packages/gateway-protocol/src/schema/sessions-row.js";

export type PreparedSessionPermissionPolicy = Readonly<{
  root: string;
  mode: SessionPermissionMode;
}>;

/** Filesystem policy for agent tools that can touch local paths. */
export type ToolFsPolicy =
  | Readonly<{ kind: "workspace"; workspaceOnly: boolean }>
  | Readonly<{
      kind: "authorized-memory-view";
      workspaceOnly: true;
      viewId: string;
      revision: string;
      virtualRoots: readonly string[];
    }>
  | Readonly<{
      kind: "sandbox-mount-plan";
      workspaceOnly: true;
      viewId: string;
      revision: string;
      mountTargets: readonly string[];
    }>
  | Readonly<{ kind: "memory-unavailable"; workspaceOnly: true }>;
