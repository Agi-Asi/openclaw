function isCanonicalIsoTimestamp(value: string): boolean {
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}

export function assertWorkspaceStateTimestamp(value: string | null, label: string): void {
  if (value !== null && !isCanonicalIsoTimestamp(value)) {
    throw new Error(`workspace ${label} timestamp is invalid`);
  }
}

export function assertWorkspaceStateIntegerTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`workspace ${label} timestamp is invalid`);
  }
}
