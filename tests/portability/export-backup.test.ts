import { describe, expect, it } from "vitest";

import type { DirectorySnapshot } from "../../src/domain/directorySnapshot";
import { backupFilename, createBackupSnapshot, exportDirectory, serializeBackup } from "../../src/portability/exportBackup";

const OWNER = { threadsUserId: "900", username: "alice" };

function snapshot(): DirectorySnapshot {
  return {
    directoryId: "dir-1",
    contacts: new Map([
      ["b", { id: "b", username: "bob", nickname: "Bob", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", identityUpdatedAt: "2026-01-01T00:00:00.000Z" }],
      ["a", { id: "a", username: "alice", nickname: "Alice", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", identityUpdatedAt: "2026-01-01T00:00:00.000Z" }],
    ]),
    tombstones: new Map([
      ["z", { contactId: "z", username: "zed", createdAt: "2026-01-01T00:00:00.000Z", deletedAt: "2026-01-02T00:00:00.000Z", reason: "user_deleted" as const }],
      ["y", { contactId: "y", username: "yara", createdAt: "2026-01-01T00:00:00.000Z", deletedAt: "2026-01-02T00:00:00.000Z", reason: "user_deleted" as const }],
    ]),
  };
}

describe("createBackupSnapshot", () => {
  it("sorts contacts by id and tombstones by contactId", () => {
    const backup = createBackupSnapshot(snapshot(), OWNER, "2026-09-14T10:55:23.000Z");

    expect(backup.contacts.map((c) => c.id)).toEqual(["a", "b"]);
    expect(backup.tombstones.map((t) => t.contactId)).toEqual(["y", "z"]);
  });
});

describe("serializeBackup determinism", () => {
  it("produces identical bytes for identical durable data at a fixed exportedAt", () => {
    const backupA = createBackupSnapshot(snapshot(), OWNER, "2026-09-14T10:55:23.000Z");
    const backupB = createBackupSnapshot(snapshot(), OWNER, "2026-09-14T10:55:23.000Z");

    expect(serializeBackup(backupA)).toBe(serializeBackup(backupB));
  });
});

describe("exportDirectory", () => {
  it("fails closed instead of exporting an invalid durable snapshot", () => {
    const corrupt: DirectorySnapshot = {
      directoryId: "dir-1",
      contacts: new Map(),
      tombstones: new Map([
        ["a", { contactId: "a", username: "alice", createdAt: "2026-01-01T00:00:00.000Z", deletedAt: "2026-01-02T00:00:00.000Z", reason: "merged" as const, mergedIntoContactId: "ghost" }],
      ]),
    };

    const result = exportDirectory(corrupt, OWNER, "2026-09-14T10:55:23.000Z");

    expect(result).toEqual({
      ok: false,
      reason: {
        kind: "invariant",
        issues: [{ code: "broken_merged_lineage", contactId: "a", mergedIntoContactId: "ghost" }],
      },
    });
  });
});

describe("backupFilename", () => {
  it("formats the exportedAt timestamp without colons or milliseconds", () => {
    expect(backupFilename("2026-09-14T10:55:23.123Z")).toBe(
      "your-name-for-threads-backup-2026-09-14T105523Z.json",
    );
  });
});
