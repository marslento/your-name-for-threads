import { describe, expect, it } from "vitest";

import type { DirectorySnapshot } from "../../src/domain/directorySnapshot";
import { buildRestoreCandidate } from "../../src/portability/buildCandidateSnapshot";
import { createBackupSnapshot, serializeBackup } from "../../src/portability/exportBackup";
import { parseBackupText } from "../../src/portability/parseBackup";

function originalSnapshot(): DirectorySnapshot {
  return {
    directoryId: "dir-1",
    contacts: new Map([
      [
        "contact-1",
        {
          id: "contact-1",
          threadsUserId: "123",
          username: "alice",
          nickname: "Alice",
          note: "met at a conference",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-05T00:00:00.000Z",
          identityUpdatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      [
        "contact-2",
        {
          id: "contact-2",
          username: "bob",
          nickname: "Bob",
          createdAt: "2026-01-02T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
          identityUpdatedAt: "2026-01-02T00:00:00.000Z",
        },
      ],
    ]),
    tombstones: new Map([
      [
        "contact-3",
        {
          contactId: "contact-3",
          username: "carol",
          createdAt: "2026-01-03T00:00:00.000Z",
          deletedAt: "2026-01-04T00:00:00.000Z",
          reason: "user_deleted",
        },
      ],
      [
        "contact-4",
        {
          contactId: "contact-4",
          username: "dave",
          createdAt: "2026-01-03T00:00:00.000Z",
          deletedAt: "2026-01-04T00:00:00.000Z",
          reason: "merged",
          mergedIntoContactId: "contact-1",
        },
      ],
    ]),
  };
}

const OWNER = { threadsUserId: "900", username: "alice" };

describe("V3 directory -> export -> parse -> validate -> restore round-trip", () => {
  it("preserves directoryId, contacts, and tombstones exactly through the full pipeline", () => {
    const original = originalSnapshot();

    const backup = createBackupSnapshot(original, OWNER, "2026-09-14T10:55:23.000Z");
    const json = serializeBackup(backup);

    const parsed = parseBackupText(json);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const restored = buildRestoreCandidate(parsed.backup);

    expect(restored.directoryId).toBe(original.directoryId);
    expect(Object.fromEntries(restored.contacts)).toEqual(Object.fromEntries(original.contacts));
    expect(Object.fromEntries(restored.tombstones)).toEqual(Object.fromEntries(original.tombstones));
  });

  it("does not require settings/cache/derived identity state to match anything (they never entered the pipeline)", () => {
    const backup = createBackupSnapshot(originalSnapshot(), OWNER, "2026-09-14T10:55:23.000Z");
    expect(backup).not.toHaveProperty("settings");
    expect(backup).not.toHaveProperty("identityCache");
    expect(backup).not.toHaveProperty("identityIndex");
    expect(backup).not.toHaveProperty("identityConflicts");
  });
});
