import { describe, expect, it } from "vitest";

import type { DirectorySnapshot } from "../../src/domain/directorySnapshot";
import {
  captureConcurrencyBaseline,
  checkImportConcurrency,
} from "../../src/portability/importConcurrency";
import type { BackupSnapshotV2 } from "../../src/portability/backupTypes";

function contact(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    username: `user-${id}`,
    nickname: "Name",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    identityUpdatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function snapshot(contacts: ReturnType<typeof contact>[] = [], tombstones: unknown[] = [], directoryId = "dir-1"): DirectorySnapshot {
  return {
    directoryId,
    contacts: new Map(contacts.map((c) => [c.id, c])),
    tombstones: new Map((tombstones as { contactId: string }[]).map((t) => [t.contactId, t as never])),
  };
}

function backup(overrides: Partial<BackupSnapshotV2> = {}): BackupSnapshotV2 {
  return {
    format: "threads-private-directory-backup",
    backupVersion: 2,
    directoryId: "incoming-dir",
    exportedAt: "2026-01-01T00:00:00.000Z",
    contacts: [],
    tombstones: [],
    ...overrides,
  };
}

describe("restore concurrency (P0)", () => {
  it("blocks execution when a contact was added locally after analysis", () => {
    const emptyLocal = snapshot([], [], "local-dir");
    const baseline = captureConcurrencyBaseline("restore", emptyLocal, backup());

    // A contact was added locally after analysis but before execution.
    const latest = snapshot([contact("new-1")], [], "local-dir");

    const result = checkImportConcurrency(baseline, latest, backup());
    expect(result.ok).toBe(false);
  });

  it("blocks execution when a tombstone appeared locally after analysis", () => {
    const emptyLocal = snapshot([], [], "local-dir");
    const baseline = captureConcurrencyBaseline("restore", emptyLocal, backup());

    const latest = snapshot([], [{ contactId: "gone", username: "gone", createdAt: "t", deletedAt: "t", reason: "user_deleted" }], "local-dir");

    expect(checkImportConcurrency(baseline, latest, backup()).ok).toBe(false);
  });

  /**
   * Restore's baseline has to span the LOCAL side too, not just the ids the
   * backup mentions (Phase 3.6 §7): those local-only records are exactly
   * what snapshot replacement silently removes, and the Preflight counted
   * them as "will be removed" (§9). Merge, which never removes anything,
   * does not need this.
   */
  it("blocks execution when a local-only record the backup never mentions appears after analysis", () => {
    const local = snapshot([contact("kept")], [], "local-dir");
    const baseline = captureConcurrencyBaseline("restore", local, backup());

    const latest = snapshot([contact("kept"), contact("added-during-review")], [], "local-dir");

    expect(checkImportConcurrency(baseline, latest, backup()).ok).toBe(false);
  });

  it("blocks execution when an existing local record was edited after analysis", () => {
    const local = snapshot([contact("shared")], [], "local-dir");
    const baseline = captureConcurrencyBaseline("restore", local, backup());

    const latest = snapshot([contact("shared", { updatedAt: "2026-02-02T00:00:00.000Z" })], [], "local-dir");

    expect(checkImportConcurrency(baseline, latest, backup()).ok).toBe(false);
  });

  it("allows execution when nothing changed locally between analysis and commit", () => {
    const local = snapshot([contact("shared")], [], "local-dir");
    const baseline = captureConcurrencyBaseline("restore", local, backup());

    expect(checkImportConcurrency(baseline, snapshot([contact("shared")], [], "local-dir"), backup()).ok).toBe(true);
  });
});

describe("self merge concurrency (P0)", () => {
  it("blocks execution when a local record newly appears under an id the backup mentions, even if absent at analysis time", () => {
    const local = snapshot([contact("unrelated")], [], "dir-1");
    const incoming = backup({ directoryId: "dir-1", contacts: [contact("new-from-backup")] });
    const baseline = captureConcurrencyBaseline("self_merge", local, incoming);

    // Between analysis and execution, a local record with the SAME id the backup mentions appears.
    const latest = snapshot([contact("unrelated"), contact("new-from-backup")], [], "dir-1");

    expect(checkImportConcurrency(baseline, latest, incoming).ok).toBe(false);
  });

  it("allows execution when an unrelated local contact changes", () => {
    const local = snapshot(
      [contact("unrelated", { updatedAt: "2026-01-01T00:00:00.000Z" }), contact("a")],
      [],
      "dir-1",
    );
    const incoming = backup({ directoryId: "dir-1", contacts: [contact("a")] });
    const baseline = captureConcurrencyBaseline("self_merge", local, incoming);

    const latest = snapshot(
      [contact("unrelated", { updatedAt: "2026-05-01T00:00:00.000Z" }), contact("a")],
      [],
      "dir-1",
    );

    expect(checkImportConcurrency(baseline, latest, incoming).ok).toBe(true);
  });

  it("blocks execution when a mentioned record's data changed", () => {
    const local = snapshot([contact("a", { updatedAt: "2026-01-01T00:00:00.000Z" })], [], "dir-1");
    const incoming = backup({ directoryId: "dir-1", contacts: [contact("a")] });
    const baseline = captureConcurrencyBaseline("self_merge", local, incoming);

    const latest = snapshot([contact("a", { updatedAt: "2026-06-01T00:00:00.000Z" })], [], "dir-1");

    expect(checkImportConcurrency(baseline, latest, incoming).ok).toBe(false);
  });
});

describe("external import concurrency (P0)", () => {
  it("blocks execution when a new local contact appears that would change an incoming contact's match classification", () => {
    const local = snapshot([], [], "local-dir");
    const incoming = backup({ directoryId: "other-dir", contacts: [contact("incoming-1", { threadsUserId: "123" })] });
    const baseline = captureConcurrencyBaseline("external_import", local, incoming);

    // A local contact with the same threadsUserId appears - "new_contact" would become "stable_duplicate".
    const latest = snapshot([contact("local-1", { threadsUserId: "123" })], [], "local-dir");

    expect(checkImportConcurrency(baseline, latest, incoming).ok).toBe(false);
  });

  it("allows execution when an unrelated local contact is added", () => {
    const local = snapshot([], [], "local-dir");
    const incoming = backup({ directoryId: "other-dir", contacts: [contact("incoming-1", { threadsUserId: "123" })] });
    const baseline = captureConcurrencyBaseline("external_import", local, incoming);

    const latest = snapshot([contact("unrelated", { threadsUserId: "999" })], [], "local-dir");

    expect(checkImportConcurrency(baseline, latest, incoming).ok).toBe(true);
  });

  it("blocks execution when the directoryId itself changed", () => {
    const local = snapshot([], [], "local-dir");
    const incoming = backup({ directoryId: "other-dir" });
    const baseline = captureConcurrencyBaseline("external_import", local, incoming);

    const latest = snapshot([], [], "different-local-dir");

    expect(checkImportConcurrency(baseline, latest, incoming).ok).toBe(false);
  });

  it("blocks execution when the matched local contact's nickname changed, even though its id and match classification stayed the same", () => {
    const localContact = contact("local-1", { threadsUserId: "123", nickname: "Original" });
    const local = snapshot([localContact], [], "local-dir");
    const incoming = backup({ directoryId: "other-dir", contacts: [contact("incoming-1", { threadsUserId: "123" })] });
    const baseline = captureConcurrencyBaseline("external_import", local, incoming);

    // Same id, same stable_duplicate classification - but the nickname changed during review.
    const latest = snapshot([contact("local-1", { threadsUserId: "123", nickname: "Changed During Review" })], [], "local-dir");

    expect(checkImportConcurrency(baseline, latest, incoming).ok).toBe(false);
  });

  it("blocks execution when the matched local contact's username changed", () => {
    const local = snapshot([contact("local-1", { threadsUserId: "123", username: "alice" })], [], "local-dir");
    const incoming = backup({ directoryId: "other-dir", contacts: [contact("incoming-1", { threadsUserId: "123" })] });
    const baseline = captureConcurrencyBaseline("external_import", local, incoming);

    const latest = snapshot([contact("local-1", { threadsUserId: "123", username: "alice-renamed" })], [], "local-dir");

    expect(checkImportConcurrency(baseline, latest, incoming).ok).toBe(false);
  });

  it("blocks execution when a locally-deleted match's tombstone data changed", () => {
    const tombstone = { contactId: "gone-1", threadsUserId: "123", username: "alice", createdAt: "t", deletedAt: "2026-01-01T00:00:00.000Z", reason: "user_deleted" as const };
    const local: DirectorySnapshot = { directoryId: "local-dir", contacts: new Map(), tombstones: new Map([["gone-1", tombstone]]) };
    const incoming = backup({ directoryId: "other-dir", contacts: [contact("incoming-1", { threadsUserId: "123" })] });
    const baseline = captureConcurrencyBaseline("external_import", local, incoming);

    const changedTombstone = { ...tombstone, deletedAt: "2026-06-01T00:00:00.000Z" };
    const latest: DirectorySnapshot = { directoryId: "local-dir", contacts: new Map(), tombstones: new Map([["gone-1", changedTombstone]]) };

    expect(checkImportConcurrency(baseline, latest, incoming).ok).toBe(false);
  });

  it("allows execution when a genuinely unrelated contact's data changes", () => {
    const local = snapshot(
      [contact("local-1", { threadsUserId: "123" }), contact("unrelated", { nickname: "Before" })],
      [],
      "local-dir",
    );
    const incoming = backup({ directoryId: "other-dir", contacts: [contact("incoming-1", { threadsUserId: "123" })] });
    const baseline = captureConcurrencyBaseline("external_import", local, incoming);

    const latest = snapshot(
      [contact("local-1", { threadsUserId: "123" }), contact("unrelated", { nickname: "After" })],
      [],
      "local-dir",
    );

    expect(checkImportConcurrency(baseline, latest, incoming).ok).toBe(true);
  });
});
