import type { Provider, ProviderAuth } from "./types.ts";

type ProviderAuthResult =
  | { auth: ProviderAuth; reason: null; status: "ready" }
  | { auth: ProviderAuth; reason: "credential_missing"; status: "blocked" };

export function resolveParallelsProviderAuth(
  input: { apiKeyEnv?: string; modelId?: string; provider: Provider },
  env: Record<string, string | undefined>,
): ProviderAuthResult;

export function runParallelsPrerequisiteEval(
  argv: string[],
  env: Record<string, string | undefined>,
  io: { write(value: string): unknown },
): 0 | 1;
