import { describe, expect, it } from "vitest";

import type { DirectorySnapshot } from "../../src/domain/directorySnapshot";
import { exportDirectory } from "../../src/portability/exportBackup";
import { parseBackupText } from "../../src/portability/parseBackup";
import { serializeBackup } from "../../src/portability/exportBackup";

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

  it("every export that succeeds can always be re-parsed by parseBackupText (round-trip guarantee)", () => {
    const result = exportDirectory(snapshotWithContact({}), OWNER, "2026-09-14T10:55:23.000Z");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = parseBackupText(serializeBackup(result.backup));
    expect(parsed.ok).toBe(true);
  });
});
