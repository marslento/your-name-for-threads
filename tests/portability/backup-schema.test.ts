import { describe, expect, it } from "vitest";

import { BackupSnapshotV2Schema } from "../../src/portability/backupSchema";
import type { BackupSnapshotV2 } from "../../src/portability/backupTypes";

function validSnapshot(): BackupSnapshotV2 {
  return {
    format: "threads-private-directory-backup",
    backupVersion: 2,
    exportedBy: { threadsUserId: "900", username: "alice" },
    directoryId: "dir-1",
    exportedAt: "2026-09-14T10:55:23.000Z",
    contacts: [
      {
        id: "contact-1",
        username: "alice",
        nickname: "Alice",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        identityUpdatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    tombstones: [],
  };
}

describe("BackupSnapshotV2Schema", () => {
  it("accepts a valid snapshot", () => {
    expect(BackupSnapshotV2Schema.safeParse(validSnapshot()).success).toBe(true);
  });

  it("rejects a nickname over 25 visible characters", () => {
    const snapshot = validSnapshot();
    snapshot.contacts[0].nickname = "a".repeat(26);

    expect(BackupSnapshotV2Schema.safeParse(snapshot).success).toBe(false);
  });

  it("rejects an empty nickname", () => {
    const snapshot = validSnapshot();
    snapshot.contacts[0].nickname = "";

    expect(BackupSnapshotV2Schema.safeParse(snapshot).success).toBe(false);
  });

  it("rejects a note over 200 visible characters", () => {
    const snapshot = validSnapshot();
    snapshot.contacts[0].note = "a".repeat(201);

    expect(BackupSnapshotV2Schema.safeParse(snapshot).success).toBe(false);
  });

  it("rejects an invalid tombstone reason", () => {
    const snapshot = validSnapshot();
    snapshot.tombstones = [
      {
        contactId: "contact-2",
        username: "bob",
        createdAt: "2026-01-01T00:00:00.000Z",
        deletedAt: "2026-01-02T00:00:00.000Z",
        // @ts-expect-error intentionally invalid
        reason: "archived",
      },
    ];

    expect(BackupSnapshotV2Schema.safeParse(snapshot).success).toBe(false);
  });

  it("rejects malformed timestamps", () => {
    const snapshot = validSnapshot();
    snapshot.contacts[0].createdAt = "not-a-date";

    expect(BackupSnapshotV2Schema.safeParse(snapshot).success).toBe(false);
  });

  it("rejects a missing directoryId", () => {
    const snapshot = validSnapshot() as Partial<BackupSnapshotV2>;
    delete snapshot.directoryId;

    expect(BackupSnapshotV2Schema.safeParse(snapshot).success).toBe(false);
  });

  it("rejects a missing owner (Phase 3.5 Task 32)", () => {
    const snapshot = validSnapshot() as Partial<BackupSnapshotV2>;
    delete snapshot.exportedBy;

    expect(BackupSnapshotV2Schema.safeParse(snapshot).success).toBe(false);
  });

  it("rejects a non-numeric owner threadsUserId", () => {
    const snapshot = validSnapshot();
    snapshot.exportedBy = { threadsUserId: "not-a-number", username: "alice" };

    expect(BackupSnapshotV2Schema.safeParse(snapshot).success).toBe(false);
  });

  it("rejects an unknown field on owner", () => {
    const snapshot = { ...validSnapshot(), exportedBy: { threadsUserId: "900", username: "alice", extra: "surprise" } };

    expect(BackupSnapshotV2Schema.safeParse(snapshot).success).toBe(false);
  });

  it("rejects a whitespace-only nickname", () => {
    const snapshot = validSnapshot();
    snapshot.contacts[0].nickname = "   ";

    expect(BackupSnapshotV2Schema.safeParse(snapshot).success).toBe(false);
  });

  it("rejects a nickname with leading/trailing whitespace (not canonical)", () => {
    const snapshot = validSnapshot();
    snapshot.contacts[0].nickname = " Alice ";

    expect(BackupSnapshotV2Schema.safeParse(snapshot).success).toBe(false);
  });

  it("does not trim a meaningful whitespace-padded note", () => {
    const snapshot = validSnapshot();
    snapshot.contacts[0].note = " hello ";

    expect(BackupSnapshotV2Schema.safeParse(snapshot).success).toBe(true);
  });

  it("rejects a whitespace-only contact id", () => {
    const snapshot = validSnapshot();
    snapshot.contacts[0].id = "   ";

    expect(BackupSnapshotV2Schema.safeParse(snapshot).success).toBe(false);
  });

  it("rejects a whitespace-only directoryId", () => {
    const snapshot = validSnapshot();
    snapshot.directoryId = "   ";

    expect(BackupSnapshotV2Schema.safeParse(snapshot).success).toBe(false);
  });

  it("rejects a whitespace-only tombstone contactId", () => {
    const snapshot = validSnapshot();
    snapshot.tombstones = [
      {
        contactId: "   ",
        username: "bob",
        createdAt: "2026-01-01T00:00:00.000Z",
        deletedAt: "2026-01-02T00:00:00.000Z",
        reason: "user_deleted",
      },
    ];

    expect(BackupSnapshotV2Schema.safeParse(snapshot).success).toBe(false);
  });

  it("still accepts a plain (non-UUID) non-blank id - no format lock-in", () => {
    const snapshot = validSnapshot();
    snapshot.contacts[0].id = "contact-1";

    expect(BackupSnapshotV2Schema.safeParse(snapshot).success).toBe(true);
  });

  it("rejects a calendar date that does not exist (e.g. Feb 30)", () => {
    const snapshot = validSnapshot();
    snapshot.contacts[0].createdAt = "2026-02-30T00:00:00.000Z";

    expect(BackupSnapshotV2Schema.safeParse(snapshot).success).toBe(false);
  });

  it("rejects unknown top-level fields (e.g. a raw settings dump passed off as a backup)", () => {
    const snapshot = { ...validSnapshot(), settings: { enabled: true } };

    expect(BackupSnapshotV2Schema.safeParse(snapshot).success).toBe(false);
  });

  it("rejects identity-derived-state fields smuggled in at the top level", () => {
    const snapshot = {
      ...validSnapshot(),
      identityCache: {},
      identityIndex: {},
      identityConflicts: {},
    };

    expect(BackupSnapshotV2Schema.safeParse(snapshot).success).toBe(false);
  });

  it("rejects unknown fields on a contact", () => {
    const snapshot = validSnapshot();
    (snapshot.contacts[0] as unknown as Record<string, unknown>).extra = "surprise";

    expect(BackupSnapshotV2Schema.safeParse(snapshot).success).toBe(false);
  });

  it("rejects unknown fields on a tombstone", () => {
    const snapshot = validSnapshot();
    snapshot.tombstones = [
      {
        contactId: "contact-2",
        username: "bob",
        createdAt: "2026-01-01T00:00:00.000Z",
        deletedAt: "2026-01-02T00:00:00.000Z",
        reason: "user_deleted",
        extra: "surprise",
      } as never,
    ];

    expect(BackupSnapshotV2Schema.safeParse(snapshot).success).toBe(false);
  });
});
