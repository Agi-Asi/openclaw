export * from "./subagent-spawn.js";

type SpawnRuntime = typeof import("./subagent-spawn.runtime.js");
type SpawnDeps = Omit<
  Pick<
    SpawnRuntime,
    | "callGateway"
    | "dispatchGatewayMethodInProcess"
    | "ensureContextEnginesInitialized"
    | "forkSessionEntryFromParent"
    | "getGlobalHookRunner"
    | "getRuntimeConfig"
    | "hasInProcessGatewayContext"
    | "loadPreparedModelCatalog"
    | "resolveContextEngine"
  >,
  "getGlobalHookRunner"
> & {
  getGlobalHookRunner: () => import("../../../plugins/hooks.js").SubagentLifecycleHookRunner | null;
};

type Testing = {
  setDepsForTest(overrides?: Partial<SpawnDeps>): void;
};

export const testing: Testing = {
  setDepsForTest: (overrides) => {
    const setDeps = (globalThis as Record<PropertyKey, unknown>)[
      Symbol.for("openclaw.subagentSpawnTestDeps")
    ] as Testing["setDepsForTest"];
    setDeps(overrides);
  },
};
