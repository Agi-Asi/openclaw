import { createHash } from "node:crypto";
import {
  normalizeCronScheduledToolCallerOrigin,
  normalizeCronScheduledToolPolicy,
  resolveCronScheduledToolPolicy,
} from "./scheduled-tool-policy.js";
import { cronJobUsesToolRuntime } from "./tools-allow.js";
import type { CronStoredJob, CronToolsAllowProvenance } from "./types.js";

const CRON_RUNTIME_AUTHORITY_ROW_FINGERPRINT_VERSION = 1;
const CRON_RUNTIME_AUTHORITY_BINDING_FINGERPRINT_VERSION = 2;

function sha256Fingerprint(version: number, canonical: unknown): string {
  return `v${version}:${createHash("sha256")
    .update(JSON.stringify(canonical), "utf8")
    .digest("hex")}`;
}

function normalizedToolsAllow(job: CronStoredJob): string[] | null {
  const toolsAllow = job.payload.toolsAllow;
  return toolsAllow === undefined ? null : [...toolsAllow].toSorted();
}

function normalizedRowProvenance(
  value: CronToolsAllowProvenance | undefined,
): CronToolsAllowProvenance | null {
  return value?.version === 1 && value.source === "final-executable-surface"
    ? { version: 1, source: "final-executable-surface" }
    : null;
}

/** Exact v1 shape retained for readers from before tool-binding persistence. */
export function cronRuntimeAuthorityRowFingerprint(job: CronStoredJob): string {
  const canonical = {
    version: CRON_RUNTIME_AUTHORITY_ROW_FINGERPRINT_VERSION,
    usesToolRuntime: cronJobUsesToolRuntime(job),
    toolsAllow: normalizedToolsAllow(job),
    toolsAllowIsDefault: job.payload.toolsAllowIsDefault === true,
    // Keep the historical raw-policy normalization here. Downgraded readers
    // must compute byte-identical v1 fingerprints for unchanged jobs.
    scheduledToolPolicy: normalizeCronScheduledToolPolicy(job.scheduledToolPolicy) ?? null,
    toolsAllowProvenance: normalizedRowProvenance(job.toolsAllowProvenance),
  };
  return sha256Fingerprint(CRON_RUNTIME_AUTHORITY_ROW_FINGERPRINT_VERSION, canonical);
}

/** Complete authorization meaning for runtime-owned scheduled tool bindings. */
export function cronRuntimeAuthorityBindingFingerprint(job: CronStoredJob): string {
  const effectiveScheduledToolPolicy =
    resolveCronScheduledToolPolicy({
      toolsAllow: job.payload.toolsAllow,
      scheduledToolPolicy: job.scheduledToolPolicy,
      owner: job.owner,
    }) ?? null;
  const provenance = normalizedRowProvenance(job.toolsAllowProvenance);
  const canonical = {
    version: CRON_RUNTIME_AUTHORITY_BINDING_FINGERPRINT_VERSION,
    rowFingerprint: cronRuntimeAuthorityRowFingerprint(job),
    owner: {
      agentId: job.owner?.agentId ?? null,
      sessionKey: job.owner?.sessionKey ?? null,
      accountId: job.owner?.accountId ?? null,
    },
    target: {
      agentId: job.agentId ?? null,
      sessionKey: job.sessionKey ?? null,
      sessionTarget: job.sessionTarget,
    },
    executionSurface: {
      payloadKind: job.payload.kind,
      triggerScript: job.trigger?.script.trim() || null,
    },
    effectiveScheduledToolPolicy,
    toolsAllowProvenance: provenance
      ? {
          ...provenance,
          callerOrigin: normalizeCronScheduledToolCallerOrigin(
            job.toolsAllowProvenance?.callerOrigin,
          ),
        }
      : null,
  };
  return sha256Fingerprint(CRON_RUNTIME_AUTHORITY_BINDING_FINGERPRINT_VERSION, canonical);
}
