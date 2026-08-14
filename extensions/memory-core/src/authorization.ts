import type { MemoryAuthorizationCapabilities } from "openclaw/plugin-sdk/memory-authorization";

/** Phase 2A admits only the complete scoped read/write lifecycle. */
export const MEMORY_CORE_AUTHORIZATION_CAPABILITIES = Object.freeze({
  version: 1,
  scopedCandidates: true,
  exactReadByAuthorizedHandle: true,
  scopedSync: true,
  scopedWrite: true,
  scopedImport: true,
  scopedExport: true,
  scopedStatus: true,
  exposureReceipts: true,
  egressReceipts: true,
}) satisfies MemoryAuthorizationCapabilities;
