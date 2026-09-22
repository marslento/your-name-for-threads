import { describe, expect, it } from "vitest";

import type { DirectorySnapshot } from "../../src/domain/directorySnapshot";
import { backupFilename, createBackupSnapshot, exportDirectory, serializeBackup } from "../../src/portability/exportBackup";

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
    const backup = createBackupSnapshot(snapshot(), "2026-09-14T10:55:23.000Z");

    expect(backup.contacts.map((c) => c.id)).toEqual(["a", "b"]);
    expect(backup.tombstones.map((t) => t.contactId)).toEqual(["y", "z"]);
  });

  it("never includes settings/identityCache/identityIndex/identityConflicts fields", () => {
    const backup = createBackupSnapshot(snapshot(), "2026-09-14T10:55:23.000Z");

    expect(backup).not.toHaveProperty("settings");
    expect(backup).not.toHaveProperty("identityCache");
    expect(backup).not.toHaveProperty("identityIndex");
    expect(backup).not.toHaveProperty("identityConflicts");
  });
});

describe("serializeBackup determinism", () => {
  it("produces identical bytes for identical durable data at a fixed exportedAt", () => {
    const backupA = createBackupSnapshot(snapshot(), "2026-09-14T10:55:23.000Z");
    const backupB = createBackupSnapshot(snapshot(), "2026-09-14T10:55:23.000Z");

    expect(serializeBackup(backupA)).toBe(serializeBackup(backupB));
  });

  it("uses two-space indentation", () => {
    const json = serializeBackup(createBackupSnapshot(snapshot(), "2026-09-14T10:55:23.000Z"));

    expect(json).toContain('\n  "format"');
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

    const result = exportDirectory(corrupt, "2026-09-14T10:55:23.000Z");

    expect(result.ok).toBe(false);
  });
});

describe("backupFilename", () => {
  it("formats the exportedAt timestamp without colons or milliseconds", () => {
    expect(backupFilename("2026-09-14T10:55:23.123Z")).toBe(
      "your-name-for-threads-backup-2026-09-14T105523Z.json",
    );
  });
});
