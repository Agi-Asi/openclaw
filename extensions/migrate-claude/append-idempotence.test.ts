// Migrate Claude tests cover append-item rerun idempotence (the same exact-import-block
// contract as the Hermes sibling migration).
import fs from "node:fs/promises";
import path from "node:path";
import type { MigrationItem } from "openclaw/plugin-sdk/plugin-entry";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspace,
  type TempWorkspace,
} from "openclaw/plugin-sdk/temp-path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendItem } from "./helpers.js";

let testWorkspace: TempWorkspace;

function makeAppendItem(root: string): MigrationItem {
  return {
    id: "memory:claude-auto-memory",
    kind: "memory",
    action: "append",
    status: "planned",
    source: path.join(root, "CLAUDE.md"),
    target: path.join(root, "AGENTS.md"),
    details: { sourceLabel: "CLAUDE.md" },
  };
}

describe("Migrate Claude append idempotence", () => {
  beforeEach(async () => {
    testWorkspace = await tempWorkspace({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "openclaw-migrate-claude-",
    });
  });

  afterEach(async () => {
    await testWorkspace.cleanup();
  });

  it("appends the import block on a first run", async () => {
    const root = testWorkspace.dir;
    await fs.writeFile(path.join(root, "CLAUDE.md"), "First instruction line.\n", "utf8");
    await fs.writeFile(path.join(root, "AGENTS.md"), "Existing target.\n", "utf8");

    const result = await appendItem(makeAppendItem(root));

    expect(result.status).toBe("migrated");
    const target = await fs.readFile(path.join(root, "AGENTS.md"), "utf8");
    expect(target).toContain("<!-- Imported from Claude: CLAUDE.md -->");
    expect(target).toContain("First instruction line.");
    expect(target.startsWith("Existing target.\n")).toBe(true);
  });

  it("skips an exact rerun and leaves target bytes unchanged", async () => {
    const root = testWorkspace.dir;
    await fs.writeFile(path.join(root, "CLAUDE.md"), "First instruction line.\n", "utf8");
    const first = await appendItem(makeAppendItem(root));
    expect(first.status).toBe("migrated");
    const bytesAfterFirst = await fs.readFile(path.join(root, "AGENTS.md"), "utf8");

    const second = await appendItem(makeAppendItem(root));

    expect(second.status).toBe("skipped");
    expect(second.reason).toBe("already imported from Claude");
    expect(await fs.readFile(path.join(root, "AGENTS.md"), "utf8")).toBe(bytesAfterFirst);
  });

  it("stays idempotent for workspace items with custom source labels", async () => {
    const root = testWorkspace.dir;
    await fs.writeFile(path.join(root, "CLAUDE.md"), "Shared rule.\n", "utf8");
    const item: MigrationItem = {
      id: "workspace:agents",
      kind: "workspace",
      action: "append",
      status: "planned",
      source: path.join(root, "CLAUDE.md"),
      target: path.join(root, "USER.md"),
      details: { sourceLabel: "workspace/CLAUDE.md" },
    };

    const first = await appendItem(item);
    const second = await appendItem(item);

    expect(first.status).toBe("migrated");
    expect(second.status).toBe("skipped");
    expect(second.reason).toBe("already imported from Claude");
    const target = await fs.readFile(path.join(root, "USER.md"), "utf8");
    expect(target.match(/Shared rule\./gu)?.length).toBe(1);
  });

  it("appends again when the source content changes", async () => {
    const root = testWorkspace.dir;
    await fs.writeFile(path.join(root, "CLAUDE.md"), "Version one.\n", "utf8");
    await appendItem(makeAppendItem(root));

    await fs.writeFile(path.join(root, "CLAUDE.md"), "Version two.\n", "utf8");
    const result = await appendItem(makeAppendItem(root));

    expect(result.status).toBe("migrated");
    const target = await fs.readFile(path.join(root, "AGENTS.md"), "utf8");
    expect(target).toContain("Version one.");
    expect(target).toContain("Version two.");
  });

  it("skips an empty source file without creating the target", async () => {
    const root = testWorkspace.dir;
    await fs.writeFile(path.join(root, "CLAUDE.md"), "   \n", "utf8");

    const result = await appendItem(makeAppendItem(root));

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("source file is empty");
    await expect(fs.readFile(path.join(root, "AGENTS.md"), "utf8")).rejects.toThrow();
  });
});
