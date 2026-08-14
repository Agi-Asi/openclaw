import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSandboxContext } from "./context.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-projection-backend-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("authorized projection backend boundary", () => {
  it("rejects SSH before it asks the broker to stage or upload private projection bytes", async () => {
    const workspaceDir = await makeTempDir();
    const stage = vi.fn(async () => {
      throw new Error("projection staging must not run");
    });

    await expect(
      resolveSandboxContext({
        agentId: "main",
        config: {
          agents: {
            entries: { main: { default: true } },
            defaults: {
              sandbox: {
                mode: "all",
                backend: "ssh",
                ssh: { target: "sandbox@example.test:22" },
              },
            },
          },
        } as never,
        sessionKey: "agent:main:direct:alice",
        workspaceDir,
        prepareAuthorizedVirtualProjectionMountPlan: stage,
      }),
    ).rejects.toThrow(/does not support authorized memory projections/);
    expect(stage).not.toHaveBeenCalled();
  });
});
