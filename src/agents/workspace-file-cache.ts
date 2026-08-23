import { isPathInside } from "../infra/path-guards.js";

type WorkspaceFileCacheEntry = {
  content: string;
  identity: string;
  sizeBytes: number;
};

// One fully populated canonical workspace may retain six 2 MiB bootstrap files.
const MAX_WORKSPACE_FILE_CACHE_BYTES = 12 * 1024 * 1024;
const workspaceFileCache = new Map<string, WorkspaceFileCacheEntry>();
let workspaceFileCacheBytes = 0;

export function deleteWorkspaceFileCacheEntry(filePath: string): void {
  const entry = workspaceFileCache.get(filePath);
  if (!entry) {
    return;
  }
  workspaceFileCache.delete(filePath);
  workspaceFileCacheBytes -= entry.sizeBytes;
}

export function readWorkspaceFileCache(filePath: string, identity: string): string | undefined {
  const entry = workspaceFileCache.get(filePath);
  if (!entry) {
    return undefined;
  }
  if (entry.identity !== identity) {
    deleteWorkspaceFileCacheEntry(filePath);
    return undefined;
  }
  workspaceFileCache.delete(filePath);
  workspaceFileCache.set(filePath, entry);
  return entry.content;
}

export function writeWorkspaceFileCache(params: {
  filePath: string;
  content: string;
  identity: string;
}): void {
  const sizeBytes = Buffer.byteLength(params.content, "utf8");
  if (sizeBytes > MAX_WORKSPACE_FILE_CACHE_BYTES) {
    return;
  }
  deleteWorkspaceFileCacheEntry(params.filePath);
  workspaceFileCache.set(params.filePath, {
    content: params.content,
    identity: params.identity,
    sizeBytes,
  });
  workspaceFileCacheBytes += sizeBytes;
  while (workspaceFileCacheBytes > MAX_WORKSPACE_FILE_CACHE_BYTES) {
    const oldest = workspaceFileCache.keys().next();
    if (oldest.done) {
      break;
    }
    deleteWorkspaceFileCacheEntry(oldest.value);
  }
}

export function retireWorkspaceFileCache(workspaceRoots: readonly string[]): void {
  for (const filePath of workspaceFileCache.keys()) {
    if (workspaceRoots.some((root) => filePath === root || isPathInside(root, filePath))) {
      deleteWorkspaceFileCacheEntry(filePath);
    }
  }
}
