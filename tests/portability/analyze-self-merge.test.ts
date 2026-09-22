import { describe, expect, it } from "vitest";

import type { ThreadContact } from "../../src/domain/contact";
import type { ContactTombstone } from "../../src/domain/tombstone";
import type { DirectorySnapshot } from "../../src/domain/directorySnapshot";
import { analyzeSelfMerge } from "../../src/portability/analyzeImport";
import type { BackupSnapshotV2 } from "../../src/portability/backupTypes";

function contact(overrides: Partial<ThreadContact>): ThreadContact {
  return {
    id: overrides.id ?? "a",
    username: "alice",
    nickname: "Alice",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    identityUpdatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function backup(overrides: Partial<BackupSnapshotV2>): BackupSnapshotV2 {
  return {
    format: "threads-private-directory-backup",
    backupVersion: 2,
    directoryId: "dir-1",
    exportedAt: "2026-02-01T00:00:00.000Z",
    contacts: [],
    tombstones: [],
    ...overrides,
  };
}

function snapshot(contacts: ThreadContact[] = [], tombstones: ContactTombstone[] = []): DirectorySnapshot {
  return {
    directoryId: "dir-1",
    contacts: new Map(contacts.map((c) => [c.id, c])),
    tombstones: new Map(tombstones.map((t) => [t.contactId, t])),
  };
}

describe("analyzeSelfMerge", () => {
  it("counts a local-only contact as unchanged", () => {
    const local = snapshot([contact({ id: "a" })]);
    const preflight = analyzeSelfMerge(local, backup({}));

    expect(preflight.summary.unchanged).toBe(1);
    expect(preflight.summary.create).toBe(0);
  });

  it("counts a backup-only contact as create", () => {
    const local = snapshot([]);
    const preflight = analyzeSelfMerge(local, backup({ contacts: [contact({ id: "a" })] }));

    expect(preflight.summary.create).toBe(1);
  });

  it("counts a backup-only tombstone as create", () => {
    const local = snapshot([]);
    const tombstone: ContactTombstone = {
      contactId: "a",
      username: "alice",
      createdAt: "2026-01-01T00:00:00.000Z",
      deletedAt: "2026-01-02T00:00:00.000Z",
      reason: "user_deleted",
    };
    const preflight = analyzeSelfMerge(local, backup({ tombstones: [tombstone] }));

    expect(preflight.summary.create).toBe(1);
  });

  it("counts an active contact turning into a tombstone as delete", () => {
    const local = snapshot([contact({ id: "a", updatedAt: "2026-01-01T00:00:00.000Z" })]);
    const tombstone: ContactTombstone = {
      contactId: "a",
      username: "alice",
      createdAt: "2026-01-01T00:00:00.000Z",
      deletedAt: "2026-01-05T00:00:00.000Z",
      reason: "user_deleted",
    };
    const preflight = analyzeSelfMerge(local, backup({ tombstones: [tombstone] }));

    expect(preflight.summary.delete).toBe(1);
  });

  it("creates a reviewable item for equal-timestamp divergent private data", () => {
    const local = snapshot([contact({ id: "a", nickname: "Local" })]);
    const incoming = contact({ id: "a", nickname: "Incoming" });
    const preflight = analyzeSelfMerge(local, backup({ contacts: [incoming] }));

    expect(preflight.summary.ambiguous).toBe(1);
    expect(preflight.items).toEqual([
      { itemId: "contact:a:private", contactId: "a", kind: "review_private_data", requiresDecision: true },
    ]);
  });

  it("reports a blocking issue for a stable identity contradiction and does not auto-merge", () => {
    const local = snapshot([contact({ id: "a", threadsUserId: "123" })]);
    const incoming = contact({ id: "a", threadsUserId: "999" });
    const preflight = analyzeSelfMerge(local, backup({ contacts: [incoming] }));

    expect(preflight.blockingIssues).toHaveLength(1);
    expect(preflight.blockingIssues[0].code).toBe("stable_identity_contradiction");
  });

  it("predicts a post-import identity conflict when two different UUIDs share a threadsUserId", () => {
    const local = snapshot([contact({ id: "a", threadsUserId: "123", username: "alice" })]);
    const incoming = contact({ id: "b", threadsUserId: "123", username: "alice-two" });
    const preflight = analyzeSelfMerge(local, backup({ contacts: [incoming] }));

    expect(preflight.summary.pendingIdentityConflictsAfterImport).toBe(1);
  });
});
