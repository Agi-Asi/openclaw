import { describe, expect, it } from "vitest";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED } from "./legacy-config-migrations.runtime.retired.js";

function applyMigration(raw: Record<string, unknown>): string[] {
  const migration = LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED.find(
    (candidate) => candidate.id === "runtime.retired-command-logger-hook",
  );
  if (!migration) {
    throw new Error("missing retired command-logger migration");
  }
  const changes: string[] = [];
  migration.apply(raw, changes);
  return changes;
}

describe("retired command-logger config migration", () => {
  it("removes the retired entry without enabling broad hook discovery", () => {
    const raw = {
      hooks: {
        internal: {
          enabled: true,
          entries: { "command-logger": { enabled: true } },
        },
      },
    };

    expect(findLegacyConfigIssues(raw)).toContainEqual({
      path: "hooks.internal.entries.command-logger",
      message: expect.stringContaining("bundled command-logger hook was removed"),
    });
    expect(applyMigration(raw)).toEqual([
      "Removed retired hooks.internal.entries.command-logger configuration.",
      "Removed retired-hook-only hooks.internal.enabled to avoid enabling broad hook discovery.",
    ]);
    expect(raw.hooks.internal).toEqual({});
  });

  it("preserves other hook configuration", () => {
    const raw = {
      hooks: {
        internal: {
          enabled: true,
          entries: {
            "command-logger": { enabled: true },
            "session-memory": { enabled: false },
          },
          load: { extraDirs: ["/opt/openclaw/hooks"] },
        },
      },
    };

    expect(applyMigration(raw)).toEqual([
      "Removed retired hooks.internal.entries.command-logger configuration.",
    ]);
    expect(raw.hooks.internal).toEqual({
      enabled: true,
      entries: { "session-memory": { enabled: false } },
      load: { extraDirs: ["/opt/openclaw/hooks"] },
    });
  });
});
