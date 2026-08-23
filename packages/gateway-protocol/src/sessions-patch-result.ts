import type { ErrorShape } from "./schema/frames.js";

export type SessionsPatchContinuationOutcome =
  | { status: "started"; runId: string }
  | { status: "rejected"; error: ErrorShape };

export type SessionsPatchActiveRunOutcome = {
  policy: "reject" | "stop" | "stop-and-continue";
  stopped: boolean;
  auditNote: "appended" | "failed";
  continuation?: SessionsPatchContinuationOutcome;
};

// Local structural result keeps this package independent of core session types.
export type SessionsPatchResult = {
  ok: true;
  path: string;
  key: string;
  entry: Record<string, unknown>;
  activeRun?: SessionsPatchActiveRunOutcome;
  resolved?: {
    modelProvider?: string;
    model?: string;
    agentRuntime?: import("./schema/agents-models-skills.js").GatewayAgentRuntime;
    contextWindow?: string;
    contextWindows?: Array<{ id: string; label: string; contextWindow: number }>;
    thinkingLevel?: string;
    thinkingLevels?: Array<{ id: string; label: string }>;
  };
};
