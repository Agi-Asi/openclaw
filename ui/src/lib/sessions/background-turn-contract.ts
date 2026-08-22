import type { ChatEvent } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";

export type SessionBackgroundTurnLaunch = {
  agentId?: string;
  key: string;
  runId: string;
};

export type SessionBackgroundTurnOutcome =
  | (SessionBackgroundTurnLaunch & { status: "completed" })
  | (SessionBackgroundTurnLaunch & {
      status: "aborted";
      errorMessage?: string;
    })
  | (SessionBackgroundTurnLaunch & {
      status: "error";
      errorKind?: Extract<ChatEvent, { state: "error" }>["errorKind"];
      errorMessage?: string;
    })
  | {
      agentId?: string;
      key: string;
      status: "initial-turn-rejected";
      errorMessage: string;
    }
  | {
      agentId?: string;
      key: string;
      status: "initial-turn-idle";
    }
  | {
      agentId?: string;
      key: string;
      status: "tracking-interrupted";
      reason: "connection-replaced" | "missing-run-id";
    };
