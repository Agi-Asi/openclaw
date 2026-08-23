import { isIncognitoSessionKey } from "../incognito-session.js";
import {
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  closeCodexStartupClientBestEffort,
  CodexAppServerUnsafeSubscriptionError,
  unsubscribeCodexThreadBestEffort,
} from "./attempt-client-cleanup.js";
import {
  isCodexAppServerLiveThreadClaimed,
  releaseCodexAppServerLiveThread,
} from "./client-runtime.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import type {
  CodexAppServerBindingIdentity,
  CodexAppServerBindingStore,
  CodexSessionGenerationRetirementResult,
} from "./session-binding.js";
import { retainSharedCodexAppServerClientByInstanceId } from "./shared-client.js";

/** Retire binding and native subscription under the same generation/physical-client ownership fence. */
export async function retireCodexAppServerSessionGeneration(params: {
  bindingStore: CodexAppServerBindingStore;
  identity: Extract<CodexAppServerBindingIdentity, { kind: "session" }>;
  mode: "reset" | "retire" | "deleted";
  assertCurrent?: () => void;
}): Promise<CodexSessionGenerationRetirementResult> {
  const { bindingStore, identity, mode, assertCurrent } = params;
  const deletion = mode === "deleted" ? "deleted" : undefined;
  const retireGeneration = () => {
    assertCurrent?.();
    return mode === "reset"
      ? bindingStore.resetSessionGeneration(identity)
      : bindingStore.retireSessionGeneration(identity, assertCurrent, deletion);
  };
  const finalizeRetirement = async (result: CodexSessionGenerationRetirementResult) => {
    if (result !== "applied" || !deletion) {
      return result;
    }
    assertCurrent?.();
    const removed = await bindingStore.removeRetiredSessionGeneration(identity, assertCurrent);
    assertCurrent?.();
    return removed ? result : "conflict";
  };
  assertCurrent?.();
  const expectedBinding = await bindingStore.read(identity);
  assertCurrent?.();
  if (!expectedBinding) {
    // Leasing an absent/retired row manufactures state or rejects its fence;
    // callers need the original absent/conflict result for reset reclamation.
    return await finalizeRetirement(await retireGeneration());
  }
  if (deletion && expectedBinding.connectionScope === "supervision") {
    return "conflict";
  }
  const leaseResult = await bindingStore.withLease(
    identity,
    async () => {
      assertCurrent?.();
      const binding = await bindingStore.read(identity);
      assertCurrent?.();
      if (binding?.threadId !== expectedBinding.threadId) {
        return "conflict";
      }
      const retirementResult = await retireGeneration();
      assertCurrent?.();
      if (retirementResult !== "applied" || !binding.clientId) {
        return retirementResult;
      }

      // Locate the original physical client only after its exact binding was
      // retired; delayed reset events must never unsubscribe a newer generation.
      const clientLease = retainSharedCodexAppServerClientByInstanceId(binding.clientId);
      if (!clientLease) {
        return retirementResult;
      }
      try {
        if (deletion && isCodexAppServerLiveThreadClaimed(clientLease.client, binding.threadId)) {
          return "conflict";
        }
        // Reset retires native-child ownership before unsubscribing its parent;
        // late child completions must never reach a replacement session generation.
        assertCurrent?.();
        codexNativeSubagentMonitorRuntime.retireParent(clientLease.client, binding.threadId);
        assertCurrent?.();
        const released = await releaseCodexAppServerLiveThread(
          clientLease.client,
          binding.threadId,
          assertCurrent,
        );
        assertCurrent?.();
        if (!released && isIncognitoSessionKey(identity.sessionKey)) {
          // Ephemeral threads have no rollout to resume, so they intentionally
          // bypass idle eviction but still end with their owning OpenClaw session.
          const unsubscribed = await unsubscribeCodexThreadBestEffort(clientLease.client, {
            threadId: binding.threadId,
            timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
            assertCurrent,
          });
          assertCurrent?.();
          if (!unsubscribed) {
            await closeCodexStartupClientBestEffort(clientLease.client);
            assertCurrent?.();
            throw new CodexAppServerUnsafeSubscriptionError(
              `Codex retired session subscription could not be released: ${binding.threadId}`,
            );
          }
        }
      } finally {
        clientLease.release();
      }
      return retirementResult;
    },
    assertCurrent,
  );
  return await finalizeRetirement(leaseResult);
}
