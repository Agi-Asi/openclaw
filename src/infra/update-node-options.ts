// Shared Node heap policy for update builds and updater-owned CLI work.
const UPDATE_MAX_OLD_SPACE_MB = 8192;

export function resolveUpdateNodeOptions(baseOptions: string | undefined): string {
  const current = baseOptions?.trim() ?? "";
  const desired = `--max-old-space-size=${UPDATE_MAX_OLD_SPACE_MB}`;
  const existingMatch = /(?:^|\s)--max-old-space-size=(\d+)(?=\s|$)/.exec(current);
  if (!existingMatch) {
    return current ? `${current} ${desired}` : desired;
  }
  const existingValue = Number(existingMatch[1]);
  if (Number.isFinite(existingValue) && existingValue >= UPDATE_MAX_OLD_SPACE_MB) {
    return current;
  }
  return current.replace(/(?:^|\s)--max-old-space-size=\d+(?=\s|$)/, ` ${desired}`).trim();
}
