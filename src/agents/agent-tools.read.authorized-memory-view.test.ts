import { describe, expect, it, vi } from "vitest";
import {
  wrapReadToolWithAuthorizedMemoryView,
  type AuthorizedMemoryVirtualRead,
} from "./agent-tools.read.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { createCoreCodingTools } from "./core-coding-tools.js";

const view: AuthorizedMemoryVirtualRead = {
  viewId: "opaque-view",
  virtualRoots: ["selected"],
  virtualPaths: ["selected/MEMORY.md", "selected/café.md"],
  readFile: async (virtualPath) => `broker:${virtualPath}`,
};

function createHarness(params?: { readFile?: AuthorizedMemoryVirtualRead["readFile"] }) {
  const genericExecute = vi.fn(async () => ({
    content: [{ type: "text", text: "generic filesystem result" }],
  }));
  const readFile = vi.fn(params?.readFile ?? view.readFile);
  const tool = wrapReadToolWithAuthorizedMemoryView(
    {
      name: "read",
      label: "read",
      description: "read a file",
      parameters: {},
      execute: genericExecute,
    } as unknown as AnyAgentTool,
    { ...view, readFile },
  );
  return { genericExecute, readFile, tool };
}

function resultText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: unknown; text?: unknown }> }).content ?? [];
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

describe("authorized memory view read boundary", () => {
  it("omits mutation, patch, exec, and process tools from the admitted core surface", () => {
    const tools = createCoreCodingTools({
      codingRoot: "/tmp/authorized-memory-view",
      includeBaseCodingTools: true,
      includeShellTools: true,
      fsPolicy: {
        kind: "authorized-memory-view",
        workspaceOnly: true,
        viewId: view.viewId,
        revision: "revision-1",
        virtualRoots: view.virtualRoots,
      },
      authorizedMemoryVirtualRead: view,
      baseToolNames: ["read", "edit", "write"],
      applyPatchEnabled: true,
      applyPatchWorkspaceOnly: true,
      execDefaults: {} as never,
      processDefaults: {} as never,
    });

    expect(tools.map((tool) => tool.name)).toEqual(["read"]);
  });

  it("reads one exact opaque manifest URI through the broker", async () => {
    const { genericExecute, readFile, tool } = createHarness();

    const result = await tool.execute("read-1", {
      path: "memory://opaque-view/selected/MEMORY.md",
    });

    expect(resultText(result)).toContain("broker:selected/MEMORY.md");
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledWith("selected/MEMORY.md");
    expect(genericExecute).not.toHaveBeenCalled();
  });

  it("rejects raw, aliased, and host paths before the generic reader or broker", async () => {
    const { genericExecute, readFile, tool } = createHarness();
    const rejectedPaths = [
      "memory/MEMORY.md",
      "/memory/selected/MEMORY.md",
      "/selected-store/MEMORY.md",
      "../memory/MEMORY.md",
      "/host/selected/MEMORY.md",
      "file:///host/selected/MEMORY.md",
      "memory://opaque-view/selected/../MEMORY.md",
      "memory://opaque-view/selected\\MEMORY.md",
      "memory://opaque-view/Selected/MEMORY.md",
      "memory://opaque-view/selected/memory.md",
      "memory://opaque-view/selected/cafe\u0301.md",
      "memory://opaque-view/selected/MEMORY.md?host=/selected-store",
      "memory:/selected/MEMORY.md",
    ];

    for (const path of rejectedPaths) {
      await expect(tool.execute(`reject:${path}`, { path })).rejects.toThrow(
        "authorized memory view path is unavailable",
      );
    }

    expect(readFile).not.toHaveBeenCalled();
    expect(genericExecute).not.toHaveBeenCalled();
  });

  it("rejects undeclared virtual paths without probing the broker", async () => {
    const { genericExecute, readFile, tool } = createHarness();

    await expect(
      tool.execute("missing", { path: "memory://opaque-view/selected/undeclared.md" }),
    ).rejects.toThrow("authorized memory view path is unavailable");

    expect(readFile).not.toHaveBeenCalled();
    expect(genericExecute).not.toHaveBeenCalled();
  });
});
