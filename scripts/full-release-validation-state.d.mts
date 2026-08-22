export * from "./full-release-validation-policy.mjs";
export function emitCheckpoint(
  lines: string[],
  write?: (fd: number, buffer: Uint8Array, offset: number, length: number) => number,
): void;
export function validateChildBinding(
  child: Record<string, unknown>,
  run: Record<string, unknown>,
  jobs: Record<string, unknown>[],
): Record<string, unknown>;
export function parsePlanInputs(value: string): Record<string, unknown>;
export function hydrateReusedPlan(
  plan: Record<string, unknown>[],
  evidence: Record<string, unknown>,
): Record<string, unknown>[];
export function formatReleaseStateHeartbeat(
  mode: string,
  decision: Record<string, unknown>,
): string;
