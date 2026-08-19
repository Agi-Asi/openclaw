import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { runUpdateFinalizationDoctorInFreshProcess } from "./update-command-fresh-doctor.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("runUpdateFinalizationDoctorInFreshProcess", () => {
  it("gives the updater-owned Doctor enough heap while preserving other Node options", async () => {
    const root = tempDirs.make("openclaw-update-doctor-heap-");
    const entryPath = path.join(root, "capture-heap.mjs");
    const outputPath = path.join(root, "heap.json");
    await fs.writeFile(
      entryPath,
      `import fs from "node:fs";
import { getHeapStatistics } from "node:v8";
fs.writeFileSync(process.env.OPENCLAW_TEST_OUTPUT_PATH, JSON.stringify({
  heapSizeLimitMiB: Math.floor(getHeapStatistics().heap_size_limit / 1024 / 1024),
  nodeOptions: process.env.NODE_OPTIONS ?? "",
}));`,
      "utf8",
    );

    await withEnvAsync(
      {
        NODE_OPTIONS: "--trace-warnings --max-old-space-size=1024",
        OPENCLAW_TEST_OUTPUT_PATH: outputPath,
      },
      async () => {
        await runUpdateFinalizationDoctorInFreshProcess({
          phase: "pre-plugin",
          root,
          yes: true,
          json: true,
          timeoutMs: 10_000,
          nodeRunner: process.execPath,
          entryPath,
        });
      },
    );

    const result = JSON.parse(await fs.readFile(outputPath, "utf8")) as {
      heapSizeLimitMiB: number;
      nodeOptions: string;
    };
    expect(result.heapSizeLimitMiB).toBeGreaterThanOrEqual(8192);
    expect(result.nodeOptions).toContain("--trace-warnings");
  });
});
