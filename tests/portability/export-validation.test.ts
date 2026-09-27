import { describe, expect, it } from "vitest";

import type { DirectorySnapshot } from "../../src/domain/directorySnapshot";
import { exportDirectory } from "../../src/portability/exportBackup";
import { parseBackupText } from "../../src/portability/parseBackup";
import { serializeBackup } from "../../src/portability/exportBackup";
import { MAX_DIRECTORY_RECORDS } from "../../src/domain/directory";
import { MAX_BACKUP_FILE_BYTES } from "../../src/portability/parseBackup";

function baseContact() {
  return {
    id: "contact-1",
    username: "alice",
    nickname: "Alice",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    identityUpdatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function snapshotWithContact(overrides: Record<string, unknown>): DirectorySnapshot {
  return {
    directoryId: "dir-1",
    contacts: new Map([["contact-1", { ...baseContact(), ...overrides } as never]]),
    tombstones: new Map(),
  };
}

const OWNER = { threadsUserId: "900", username: "alice" };

describe("exportDirectory fails closed on schema-level corruption (not just invariants)", () => {
  it("rejects an empty nickname", () => {
    const result = exportDirectory(snapshotWithContact({ nickname: "" }), OWNER, "2026-09-14T10:55:23.000Z");
    expect(result.ok).toBe(false);
  });

  it("rejects a note over 200 visible characters", () => {
    const result = exportDirectory(snapshotWithContact({ note: "a".repeat(201) }), OWNER, "2026-09-14T10:55:23.000Z");
    expect(result.ok).toBe(false);
  });

  it("rejects a non-canonical (non-normalized) username", () => {
    const result = exportDirectory(snapshotWithContact({ username: "Alice" }), OWNER, "2026-09-14T10:55:23.000Z");
    expect(result.ok).toBe(false);
  });

  it("rejects an invalid timestamp", () => {
    const result = exportDirectory(snapshotWithContact({ updatedAt: "not-a-date" }), OWNER, "2026-09-14T10:55:23.000Z");
    expect(result.ok).toBe(false);
  });

  it("rejects an invalid tombstone reason", () => {
    const snapshot: DirectorySnapshot = {
      directoryId: "dir-1",
      contacts: new Map(),
      tombstones: new Map([
        [
          "contact-2",
          {
            contactId: "contact-2",
            username: "bob",
            createdAt: "2026-01-01T00:00:00.000Z",
            deletedAt: "2026-01-02T00:00:00.000Z",
            reason: "archived" as never,
          },
        ],
      ]),
    };
    expect(exportDirectory(snapshot, OWNER, "2026-09-14T10:55:23.000Z").ok).toBe(false);
  });

  it("rejects an empty directoryId", () => {
    const snapshot: DirectorySnapshot = { directoryId: "", contacts: new Map(), tombstones: new Map() };
    expect(exportDirectory(snapshot, OWNER, "2026-09-14T10:55:23.000Z").ok).toBe(false);
  });

  it("an ordinary export can be re-imported without a restore warning", () => {
    const result = exportDirectory(snapshotWithContact({}), OWNER, "2026-09-14T10:55:23.000Z");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.exceedsImportLimits).toBeFalsy();
    const parsed = parseBackupText(serializeBackup(result.backup));
    expect(parsed.ok).toBe(true);
  });
});

describe("exports preserve data beyond the current import limits", () => {
  it("exports every legacy record but flags that the importer cannot restore this file", () => {
    const snapshot = snapshotWithContact({});
    snapshot.contacts = new Map(Array.from({ length: MAX_DIRECTORY_RECORDS + 1 }, (_, index) => {
      const id = `contact-${index}`;
      return [id, { ...baseContact(), id, username: `user${index}` }];
    }));
    const result = exportDirectory(snapshot, OWNER, "2026-09-14T10:55:23.000Z");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Export should preserve legacy data");
    expect(result.exceedsImportLimits).toBe(true);
    expect(new Blob([result.json]).size).toBeLessThan(MAX_BACKUP_FILE_BYTES);
    expect(JSON.parse(result.json).contacts).toHaveLength(MAX_DIRECTORY_RECORDS + 1);
    expect(parseBackupText(result.json)).toMatchObject({ ok: false });
  });

  it("flags UTF-8 file size even when the record count is within the limit", () => {
    const snapshot = snapshotWithContact({});
    snapshot.contacts = new Map(Array.from({ length: 13_000 }, (_, index) => {
      const id = `contact-${index}`;
      return [id, { ...baseContact(), id, username: `user${index}`, note: "備".repeat(200) }];
    }));
    const result = exportDirectory(snapshot, OWNER, "2026-09-14T10:55:23.000Z");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Export should preserve all notes");
    expect(result.json.length).toBeLessThan(MAX_BACKUP_FILE_BYTES);
    expect(new Blob([result.json]).size).toBeGreaterThan(MAX_BACKUP_FILE_BYTES);
    expect(result.exceedsImportLimits).toBe(true);
    expect(JSON.parse(result.json).contacts[0].note).toBe("備".repeat(200));
  });
});
