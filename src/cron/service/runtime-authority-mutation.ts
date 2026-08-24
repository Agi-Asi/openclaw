import { cronRuntimeAuthorityBindingFingerprint } from "../runtime-authority-input.js";
import { cloneCronRuntimeAuthority, type CronRuntimeAuthority } from "../runtime-authority.js";
import { cronJobUsesToolRuntime } from "../tools-allow.js";
import type { CronStoredJob } from "../types.js";

/** Reconciles runtime-private authority at the store-locked cron mutation owner. */
export function reconcileCronRuntimeAuthority(params: {
  job: CronStoredJob;
  previousJob?: CronStoredJob;
  captured: boolean;
  runtimeAuthority?: CronRuntimeAuthority;
  explicitlyMutatesToolsAllow: boolean;
}): void {
  if (!cronJobUsesToolRuntime(params.job)) {
    delete params.job.runtimeAuthority;
    delete params.job.runtimeAuthorityRecoveryRequired;
    return;
  }
  if (params.captured) {
    delete params.job.runtimeAuthorityRecoveryRequired;
    const runtimeAuthority = params.runtimeAuthority
      ? cloneCronRuntimeAuthority(params.runtimeAuthority)
      : undefined;
    if (params.runtimeAuthority && !runtimeAuthority) {
      throw new TypeError("captured cron runtime authority is invalid");
    }
    if (runtimeAuthority) {
      params.job.runtimeAuthority = runtimeAuthority;
    } else {
      delete params.job.runtimeAuthority;
    }
    return;
  }
  if (
    params.job.runtimeAuthority &&
    params.previousJob &&
    cronRuntimeAuthorityBindingFingerprint(params.previousJob) !==
      cronRuntimeAuthorityBindingFingerprint(params.job)
  ) {
    // Only a fresh exact-run capture may carry authority across an owner,
    // target, policy, script, or executable-surface change.
    params.job.runtimeAuthorityRecoveryRequired = true;
    delete params.job.runtimeAuthority;
    return;
  }
  if (params.explicitlyMutatesToolsAllow && params.job.runtimeAuthority) {
    params.job.runtimeAuthorityRecoveryRequired = true;
    delete params.job.runtimeAuthority;
  }
}
