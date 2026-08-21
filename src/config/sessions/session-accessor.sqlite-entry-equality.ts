import type { SessionEntry } from "./types.js";

type SqliteLifecycleTargetSnapshot = {
  primary: { entry: SessionEntry; key: string } | undefined;
  rows: Array<{ entry: SessionEntry; sessionKey: string }>;
};

type SessionEntryComparator = (
  left: SessionEntry | undefined,
  right: SessionEntry | undefined,
) => boolean;

export function sqliteSessionEntriesEqual(
  left: SessionEntry | undefined,
  right: SessionEntry | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  const {
    participants: _leftParticipants,
    participantCount: _leftParticipantCount,
    ...leftEntry
  } = left;
  const {
    participants: _rightParticipants,
    participantCount: _rightParticipantCount,
    ...rightEntry
  } = right;
  // Participant display metadata is a separately mutable projection. Owner
  // remains part of the generic fence because detached replacements must fail
  // when responsibility changes after their snapshot.
  return JSON.stringify(leftEntry) === JSON.stringify(rightEntry);
}

export function sqliteLifecycleSessionEntriesEqual(
  left: SessionEntry | undefined,
  right: SessionEntry | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  const { owner: _leftOwner, ...leftEntry } = left;
  const { owner: _rightOwner, ...rightEntry } = right;
  // Lifecycle writes preserve the separately stored owner columns, so an owner
  // assignment must not invalidate their logical-entry snapshot.
  return sqliteSessionEntriesEqual(leftEntry, rightEntry);
}

export function sqliteSessionSnapshotRowsEqual(
  left: Array<{ entry: SessionEntry; sessionKey: string }>,
  right: Array<{ entry: SessionEntry; sessionKey: string }>,
  entriesEqual: SessionEntryComparator = sqliteSessionEntriesEqual,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (row, index) =>
        row.sessionKey === right[index]?.sessionKey && entriesEqual(row.entry, right[index]?.entry),
    )
  );
}

export function sqliteLifecycleTargetSnapshotsEqual(
  expected: SqliteLifecycleTargetSnapshot,
  current: SqliteLifecycleTargetSnapshot,
): boolean {
  return sqliteTargetSnapshotsEqual(expected, current, sqliteLifecycleSessionEntriesEqual);
}

export function sqliteSessionTargetSnapshotsEqual(
  expected: SqliteLifecycleTargetSnapshot,
  current: SqliteLifecycleTargetSnapshot,
): boolean {
  return sqliteTargetSnapshotsEqual(expected, current, sqliteSessionEntriesEqual);
}

function sqliteTargetSnapshotsEqual(
  expected: SqliteLifecycleTargetSnapshot,
  current: SqliteLifecycleTargetSnapshot,
  entriesEqual: SessionEntryComparator,
): boolean {
  return (
    expected.primary?.key === current.primary?.key &&
    entriesEqual(expected.primary?.entry, current.primary?.entry) &&
    expected.rows.length === current.rows.length &&
    expected.rows.every(
      (row, index) =>
        row.sessionKey === current.rows[index]?.sessionKey &&
        entriesEqual(row.entry, current.rows[index]?.entry),
    )
  );
}
