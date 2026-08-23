import type { SubagentLifecycleHookRunner } from "../../../plugins/hooks.js";
import { callInProcessGatewayToolWithCreation } from "../../tools/in-process-gateway.js";
import {
  callGateway,
  dispatchGatewayMethodInProcess,
  ensureContextEnginesInitialized,
  forkSessionEntryFromParent,
  getGlobalHookRunner,
  getRuntimeConfig,
  hasInProcessGatewayContext,
  loadPreparedModelCatalog,
  resolveProviderRefOwnership,
  resolveContextEngine,
} from "./subagent-spawn.runtime.js";

type SubagentSpawnDeps = {
  callGateway: typeof callGateway;
  dispatchGatewayMethodInProcess: typeof dispatchGatewayMethodInProcess;
  forkSessionEntryFromParent: typeof forkSessionEntryFromParent;
  getGlobalHookRunner: () => SubagentLifecycleHookRunner | null;
  getRuntimeConfig: typeof getRuntimeConfig;
  hasInProcessGatewayContext: typeof hasInProcessGatewayContext;
  ensureContextEnginesInitialized: typeof ensureContextEnginesInitialized;
  loadPreparedModelCatalog: typeof loadPreparedModelCatalog;
  resolveProviderRefOwnership: typeof resolveProviderRefOwnership;
  resolveContextEngine: typeof resolveContextEngine;
  createGatewaySession: typeof callInProcessGatewayToolWithCreation;
};

const defaultSubagentSpawnDeps: SubagentSpawnDeps = {
  callGateway,
  dispatchGatewayMethodInProcess,
  forkSessionEntryFromParent,
  getGlobalHookRunner,
  getRuntimeConfig,
  hasInProcessGatewayContext,
  ensureContextEnginesInitialized,
  loadPreparedModelCatalog,
  resolveProviderRefOwnership,
  resolveContextEngine,
  createGatewaySession: callInProcessGatewayToolWithCreation,
};

let subagentSpawnDeps = defaultSubagentSpawnDeps;

export function getSubagentSpawnDeps(): SubagentSpawnDeps {
  return subagentSpawnDeps;
}

function setSubagentSpawnDepsForTest(overrides?: Partial<SubagentSpawnDeps>): void {
  subagentSpawnDeps = overrides
    ? {
        ...defaultSubagentSpawnDeps,
        ...overrides,
      }
    : defaultSubagentSpawnDeps;
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  // SAFETY: this test-only symbol is written and consumed with the same setter contract.
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.subagentSpawnTestDeps")] =
    setSubagentSpawnDepsForTest;
}
