import { describe, expect, it } from "vitest";

import { validateBackupInvariants } from "../../src/portability/validateBackup";
import type { BackupSnapshotV2 } from "../../src/portability/backupTypes";

function backup(overrides: Partial<BackupSnapshotV2> = {}): BackupSnapshotV2 {
  return {
    format: "threads-private-directory-backup",
    backupVersion: 2,
    directoryId: "dir-1",
    exportedAt: "2026-01-01T00:00:00.000Z",
    contacts: [],
    tombstones: [],
    ...overrides,
  };
}

const contact = (id: string) => ({
  id,
  username: `user-${id}`,
  nickname: "Name",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  identityUpdatedAt: "2026-01-01T00:00:00.000Z",
});

const tombstone = (contactId: string, overrides: Record<string, unknown> = {}) => ({
  contactId,
  username: `user-${contactId}`,
  createdAt: "2026-01-01T00:00:00.000Z",
  deletedAt: "2026-01-02T00:00:00.000Z",
  reason: "user_deleted" as const,
  ...overrides,
});

describe("validateBackupInvariants", () => {
  it("rejects two distinct active contacts claiming the same username", () => {
    const result = validateBackupInvariants(backup({ contacts: [
      { ...contact("a"), username: "alice", threadsUserId: "123" },
      { ...contact("b"), username: "alice", threadsUserId: "456" },
    ] }));

    expect(result).toMatchObject({ ok: false, issues: expect.arrayContaining([
      { code: "duplicate_username", contactId: "b", username: "alice" },
    ]) });
  });

  it("allows a deleted contact's username to be reused by an active contact", () => {
    expect(validateBackupInvariants(backup({
      contacts: [{ ...contact("a"), username: "alice" }],
      tombstones: [{ ...tombstone("b"), username: "alice" }],
    }))).toEqual({ ok: true });
  });

  it("accepts a well-formed snapshot", () => {
    expect(validateBackupInvariants(backup({ contacts: [contact("a")] }))).toEqual({ ok: true });
  });

  it("allows multiple active contacts with the same threadsUserId", () => {
    const result = validateBackupInvariants(
      backup({
        contacts: [
          { ...contact("a"), threadsUserId: "123" },
          { ...contact("b"), threadsUserId: "123" },
        ],
      }),
    );

    expect(result).toEqual({ ok: true });
  });

  it("rejects duplicate contact IDs", () => {
    const result = validateBackupInvariants(backup({ contacts: [contact("a"), contact("a")] }));

    expect(result).toMatchObject({ ok: false, issues: [{ code: "duplicate_contact_id", contactId: "a" }] });
  });

  it("rejects duplicate tombstone contact IDs", () => {
    const result = validateBackupInvariants(backup({ tombstones: [tombstone("a"), tombstone("a")] }));

    expect(result).toMatchObject({ ok: false, issues: [{ code: "duplicate_tombstone_id", contactId: "a" }] });
  });

  it("rejects a contact that is both active and tombstoned", () => {
    const result = validateBackupInvariants(
      backup({ contacts: [contact("a")], tombstones: [tombstone("a")] }),
    );

    expect(result).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([{ code: "active_and_tombstone_same_id", contactId: "a" }]),
    });
  });

  it("rejects a merged tombstone missing mergedIntoContactId", () => {
    const result = validateBackupInvariants(
      backup({ tombstones: [tombstone("a", { reason: "merged" })] }),
    );

    expect(result).toMatchObject({ ok: false, issues: [{ code: "invalid_tombstone", contactId: "a" }] });
  });

  it("rejects a merged tombstone pointing to itself", () => {
    const result = validateBackupInvariants(
      backup({
        contacts: [contact("canonical")],
        tombstones: [tombstone("a", { reason: "merged", mergedIntoContactId: "a" })],
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([{ code: "merged_tombstone_self_reference", contactId: "a" }]),
    });
  });

  it("rejects a merged tombstone whose target does not resolve to an active contact", () => {
    const result = validateBackupInvariants(
      backup({ tombstones: [tombstone("a", { reason: "merged", mergedIntoContactId: "ghost" })] }),
    );

    expect(result).toMatchObject({
      ok: false,
      issues: [{ code: "broken_merged_lineage", contactId: "a", mergedIntoContactId: "ghost" }],
    });
  });

  it("accepts a valid merged tombstone whose canonical contact is active", () => {
    const result = validateBackupInvariants(
      backup({
        contacts: [contact("canonical")],
        tombstones: [tombstone("a", { reason: "merged", mergedIntoContactId: "canonical" })],
      }),
    );

    expect(result).toEqual({ ok: true });
  });
});
