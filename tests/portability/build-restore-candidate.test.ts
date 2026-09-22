import { describe, expect, it } from "vitest";

import { buildRestoreCandidate } from "../../src/portability/buildCandidateSnapshot";
import type { BackupSnapshotV2 } from "../../src/portability/backupTypes";

describe("buildRestoreCandidate", () => {
  it("adopts the incoming directoryId and preserves UUIDs/timestamps exactly", () => {
    const backup: BackupSnapshotV2 = {
      format: "threads-private-directory-backup",
      backupVersion: 2,
      directoryId: "incoming-dir",
      exportedAt: "2026-01-01T00:00:00.000Z",
      contacts: [
        {
          id: "contact-1",
          username: "alice",
          nickname: "Alice",
          createdAt: "2020-01-01T00:00:00.000Z",
          updatedAt: "2020-01-02T00:00:00.000Z",
          identityUpdatedAt: "2020-01-01T00:00:00.000Z",
        },
      ],
      tombstones: [
        {
          contactId: "contact-2",
          username: "bob",
          createdAt: "2020-01-01T00:00:00.000Z",
          deletedAt: "2020-01-03T00:00:00.000Z",
          reason: "user_deleted",
        },
      ],
    };

    const candidate = buildRestoreCandidate(backup);

    expect(candidate.directoryId).toBe("incoming-dir");
    expect(candidate.contacts.get("contact-1")).toEqual(backup.contacts[0]);
    expect(candidate.tombstones.get("contact-2")).toEqual(backup.tombstones[0]);
  });
});
