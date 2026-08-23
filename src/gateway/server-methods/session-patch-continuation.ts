import { randomUUID } from "node:crypto";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { formatSystemTurnPrompt } from "../../sessions/system-turn-prompt.js";
import { handleTrustedInternalChatSend } from "./chat-send-handler.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const PATCH_CONTINUATION_TEXT =
  "Continue the interrupted work under the session's updated execution policy.";

export async function launchSessionPatchContinuation(params: {
  agentId: string;
  client: GatewayRequestHandlerOptions["client"];
  context: GatewayRequestHandlerOptions["context"];
  req: GatewayRequestHandlerOptions["req"];
  sessionId: string;
  sessionKey: string;
  assertCurrent: () => void;
}) {
  let outcome:
    | { status: "started"; runId: string }
    | { status: "rejected"; error: ReturnType<typeof errorShape> }
    | undefined;
  try {
    await handleTrustedInternalChatSend(
      {
        req: params.req,
        params: {
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          sessionId: params.sessionId,
          message: formatSystemTurnPrompt(PATCH_CONTINUATION_TEXT),
          idempotencyKey: `sessions-patch-continuation:${params.sessionId}:${randomUUID()}`,
          deliver: false,
          suppressCommandInterpretation: true,
          systemInputProvenance: {
            kind: "internal_system",
            sourceSessionKey: params.sessionKey,
            sourceTool: "sessions.patch",
          },
        },
        respond: (ok, payload, error) => {
          const responseRunId =
            typeof payload === "object" && payload !== null && "runId" in payload
              ? payload.runId
              : undefined;
          const runId = ok && typeof responseRunId === "string" ? responseRunId.trim() : "";
          outcome =
            ok && runId
              ? { status: "started", runId }
              : {
                  status: "rejected",
                  error:
                    error ?? errorShape(ErrorCodes.UNAVAILABLE, "Continuation was not started."),
                };
        },
        context: params.context,
        client: params.client,
        isWebchatConnect: () => false,
      },
      async () => {
        params.assertCurrent();
        return true;
      },
    );
  } catch (error) {
    outcome = {
      status: "rejected",
      error: errorShape(
        ErrorCodes.UNAVAILABLE,
        error instanceof Error ? error.message : "Continuation launch failed.",
      ),
    };
  }
  return (
    outcome ?? {
      status: "rejected" as const,
      error: errorShape(ErrorCodes.UNAVAILABLE, "Continuation returned no outcome."),
    }
  );
}
