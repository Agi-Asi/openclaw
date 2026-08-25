const INVALID_ARGUMENTS = new Error("invalid arguments");
const PROVIDERS = {
  anthropic: {
    authChoice: "apiKey",
    authKeyFlag: "anthropic-api-key",
    modelEnv: "OPENCLAW_PARALLELS_ANTHROPIC_MODEL",
    modelId: "anthropic/claude-sonnet-4-6",
  },
  minimax: {
    authChoice: "minimax-global-api",
    authKeyFlag: "minimax-api-key",
    modelEnv: "OPENCLAW_PARALLELS_MINIMAX_MODEL",
    modelId: "minimax/MiniMax-M2.7",
  },
  openai: {
    authChoice: "apiKey",
    authKeyFlag: "openai-api-key",
    modelEnv: "OPENCLAW_PARALLELS_OPENAI_MODEL",
    modelId: "openai/gpt-5.6-luna",
  },
};

export function resolveParallelsProviderAuth(input, env) {
  const defaults = Object.hasOwn(PROVIDERS, input.provider) ? PROVIDERS[input.provider] : undefined;
  if (!defaults) {
    throw INVALID_ARGUMENTS;
  }
  const apiKeyEnv = input.apiKeyEnv || `${input.provider.toUpperCase()}_API_KEY`;
  const apiKeyValue = Object.hasOwn(env, apiKeyEnv) ? (env[apiKeyEnv] ?? "") : "";
  const auth = {
    apiKeyEnv,
    apiKeyValue,
    authChoice: defaults.authChoice,
    authKeyFlag: defaults.authKeyFlag,
    modelId: input.modelId || env[defaults.modelEnv] || defaults.modelId,
    ...(input.provider === "minimax" ? {} : { tokenProvider: input.provider }),
  };
  return auth.apiKeyValue
    ? { auth, reason: null, status: "ready" }
    : { auth, reason: "credential_missing", status: "blocked" };
}

export function runParallelsPrerequisiteEval(argv, env, io) {
  let reason;
  try {
    const args = argv[0] === "--" ? argv.slice(1) : argv;
    if (args[0] !== "--prerequisite-check") {
      throw INVALID_ARGUMENTS;
    }
    const input = { provider: "openai" };
    const seen = new Set();
    for (let index = 1; index < args.length; index++) {
      const flag = args[index];
      const key = flag === "--openai-api-key-env" ? "--api-key-env" : flag;
      if (seen.has(key) || !["--api-key-env", "--json", "--model", "--provider"].includes(key)) {
        throw INVALID_ARGUMENTS;
      }
      seen.add(key);
      if (key === "--json") {
        continue;
      }
      const value = args[++index];
      if (!value || value.startsWith("-")) {
        throw INVALID_ARGUMENTS;
      }
      if (key === "--api-key-env") {
        input.apiKeyEnv = value;
      } else if (key === "--model") {
        input.modelId = value;
      } else {
        input.provider = value;
      }
    }
    if (!seen.has("--json")) {
      throw INVALID_ARGUMENTS;
    }
    const result = resolveParallelsProviderAuth(input, env);
    reason = result.reason;
  } catch (error) {
    reason = error === INVALID_ARGUMENTS ? "invalid_arguments" : "internal_error";
  }
  const status = reason === null ? "ready" : "blocked";
  io.write(`${JSON.stringify({ schema: "openclaw.parallels-prerequisite.v1", status, reason })}\n`);
  return status === "ready" ? 0 : 1;
}
