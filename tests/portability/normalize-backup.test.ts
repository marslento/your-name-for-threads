import { describe, expect, it } from "vitest";

import { normalizeBackup, normalizeNote } from "../../src/portability/normalizeBackup";
import type { BackupSnapshotV2 } from "../../src/portability/backupTypes";

describe("normalizeNote", () => {
  it("turns an empty string into undefined", () => {
    expect(normalizeNote("")).toBeUndefined();
  });

  it("leaves whitespace-only non-empty notes unchanged", () => {
    expect(normalizeNote("   ")).toBe("   ");
  });

  it("preserves a multiline note exactly", () => {
    expect(normalizeNote("line one\nline two")).toBe("line one\nline two");
  });

  it("leaves undefined as undefined", () => {
    expect(normalizeNote(undefined)).toBeUndefined();
  });
});

describe("normalizeBackup", () => {
  it("canonicalizes every contact's empty note to omit the field", () => {
    const backup: BackupSnapshotV2 = {
      format: "threads-private-directory-backup",
      backupVersion: 2,
      directoryId: "dir-1",
      exportedAt: "2026-01-01T00:00:00.000Z",
      contacts: [
        {
          id: "contact-1",
          username: "alice",
          nickname: "Alice",
          note: "",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          identityUpdatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      tombstones: [],
    };

    const normalized = normalizeBackup(backup);

    expect(normalized.contacts[0]).not.toHaveProperty("note");
  });

  it("does not trim a meaningful note", () => {
    const backup: BackupSnapshotV2 = {
      format: "threads-private-directory-backup",
      backupVersion: 2,
      directoryId: "dir-1",
      exportedAt: "2026-01-01T00:00:00.000Z",
      contacts: [
        {
          id: "contact-1",
          username: "alice",
          nickname: "Alice",
          note: " hello ",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          identityUpdatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      tombstones: [],
    };

    expect(normalizeBackup(backup).contacts[0].note).toBe(" hello ");
  });
});
