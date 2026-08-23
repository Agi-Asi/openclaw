export type ManagedWorktreeOwnerKind = "manual" | "workboard" | "session";

export type ManagedWorktreeRunEndCleanupOutcome =
  | "removed-lossless"
  | "retained-busy"
  | "retained-dirty"
  | "retained-unpushed"
  | "retained-provisioned-drift"
  | "failed";

export type ManagedWorktreeRunEndCleanup = {
  outcome: ManagedWorktreeRunEndCleanupOutcome;
  at: number;
  reason?: string;
};

export type ProvisionedFileState = {
  path: string;
  mode: number | null;
  chunks: number;
};

export type ManagedWorktreeRecord = {
  id: string;
  name: string;
  repoFingerprint: string;
  repoRoot: string;
  path: string;
  branch: string;
  baseRef: string;
  ownerKind: ManagedWorktreeOwnerKind;
  ownerId?: string;
  snapshotRef?: string;
  createdAt: number;
  lastActiveAt: number;
  removedAt?: number;
  runEndCleanup?: ManagedWorktreeRunEndCleanup;
};

type ManagedWorktreeCreationStage =
  | "preparing"
  | "fetching-base"
  | "checking-out"
  | "provisioning-files"
  | "running-setup";

export type CreateManagedWorktreeParams = {
  repoRoot: string;
  name?: string;
  /** Derived default name; collisions receive a stable numeric suffix. */
  suggestedName?: string;
  baseRef?: string;
  ownerKind?: ManagedWorktreeOwnerKind;
  ownerId?: string;
  // Repository checkout hooks and .openclaw/worktree-setup.sh execute repo-local code, so
  // callers reachable from less-privileged surfaces opt out; admin paths keep them on.
  runSetupScript?: boolean;
  /** Synchronous caller-authority guard checked at allocation commit boundaries. */
  commitGuard?: () => void;
  /** Synchronous producer-owned stage observer. */
  onStage?: (stage: ManagedWorktreeCreationStage) => Promise<void> | void;
  /** Raw process output in producer order. */
  onOutput?: (chunk: Buffer, stream: "stdout" | "stderr") => void;
  signal?: AbortSignal;
};

export type RemoveManagedWorktreeResult = {
  removed: boolean;
  snapshotRef?: string;
  snapshotError?: string;
};

export type ManagedWorktreeBranch = {
  name: string;
  kind: "local" | "remote";
};

type ManagedWorktreeRepositoryStatus = "git" | "not_git" | "unavailable";

export type ManagedWorktreeBranchesResult = {
  branches: ManagedWorktreeBranch[];
  defaultBranch?: string;
  headBranch?: string;
  repositoryStatus?: ManagedWorktreeRepositoryStatus;
};

export type ManagedWorktreeGcResult = {
  removed: string[];
  orphansDeleted: number;
  snapshotsPruned: number;
};
