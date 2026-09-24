import { describe, expect, it } from "vitest";

import type { DirectorySnapshot } from "../../src/domain/directorySnapshot";
import { validateCandidateSnapshot } from "../../src/portability/validateCandidate";

function baseSnapshot(): DirectorySnapshot {
  return {
    directoryId: "dir-1",
    contacts: new Map([
      [
        "a",
        {
          id: "a",
          username: "alice",
          nickname: "Alice",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          identityUpdatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    ]),
    tombstones: new Map(),
  };
}

describe("validateCandidateSnapshot", () => {
  it("rejects username collisions introduced while combining otherwise valid contacts", () => {
    const snapshot = baseSnapshot();
    snapshot.contacts.set("b", { ...snapshot.contacts.get("a")!, id: "b", threadsUserId: "456" });

    expect(validateCandidateSnapshot(snapshot)).toMatchObject({ ok: false, issues: expect.arrayContaining([
      { code: "duplicate_username", contactId: "b", username: "alice" },
    ]) });
  });

  it("allows shared stable IDs when active usernames differ", () => {
    const snapshot = baseSnapshot();
    snapshot.contacts.get("a")!.threadsUserId = "123";
    snapshot.contacts.set("b", { ...snapshot.contacts.get("a")!, id: "b", username: "alice_old" });

    expect(validateCandidateSnapshot(snapshot)).toEqual({ ok: true });
  });

  it("accepts a well-formed candidate", () => {
    expect(validateCandidateSnapshot(baseSnapshot())).toEqual({ ok: true });
  });

  it("rejects a nickname outside 1-25 characters", () => {
    const snapshot = baseSnapshot();
    snapshot.contacts.get("a")!.nickname = "";

    expect(validateCandidateSnapshot(snapshot)).toMatchObject({ ok: false, issues: [{ code: "invalid_nickname" }] });
  });

  it("rejects a note over 200 characters", () => {
    const snapshot = baseSnapshot();
    snapshot.contacts.get("a")!.note = "a".repeat(201);

    expect(validateCandidateSnapshot(snapshot)).toMatchObject({ ok: false, issues: [{ code: "invalid_note" }] });
  });

  it("rejects a contact that is also tombstoned", () => {
    const snapshot = baseSnapshot();
    snapshot.tombstones.set("a", {
      contactId: "a",
      username: "alice",
      createdAt: "2026-01-01T00:00:00.000Z",
      deletedAt: "2026-01-02T00:00:00.000Z",
      reason: "user_deleted",
    });

    expect(validateCandidateSnapshot(snapshot)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([{ code: "active_and_tombstone_same_id", contactId: "a" }]),
    });
  });

  it("rejects a candidate missing a directoryId", () => {
    const snapshot = { ...baseSnapshot(), directoryId: "" };

    expect(validateCandidateSnapshot(snapshot)).toMatchObject({ ok: false, issues: [{ code: "invalid_directory_id" }] });
  });

  it("rejects a non-canonical (non-normalized) username", () => {
    const snapshot = baseSnapshot();
    snapshot.contacts.get("a")!.username = "Alice";

    expect(validateCandidateSnapshot(snapshot)).toMatchObject({ ok: false, issues: [{ code: "invalid_username", contactId: "a" }] });
  });

  it("rejects a threadsUserId that is not ASCII-digits-only", () => {
    const snapshot = baseSnapshot();
    snapshot.contacts.get("a")!.threadsUserId = "abc123";

    expect(validateCandidateSnapshot(snapshot)).toMatchObject({
      ok: false,
      issues: [{ code: "invalid_threads_user_id", contactId: "a" }],
    });
  });

  it("rejects a tombstone with a reason outside the defined enum", () => {
    const snapshot = baseSnapshot();
    snapshot.tombstones.set("b", {
      contactId: "b",
      username: "bob",
      createdAt: "2026-01-01T00:00:00.000Z",
      deletedAt: "2026-01-02T00:00:00.000Z",
      reason: "archived" as never,
    });

    expect(validateCandidateSnapshot(snapshot)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([{ code: "invalid_tombstone_reason", contactId: "b" }]),
    });
  });

  it("rejects an impossible calendar date, not silently rolling it over (Date.parse would accept 2026-02-30 as March 2)", () => {
    const snapshot = baseSnapshot();
    snapshot.contacts.get("a")!.updatedAt = "2026-02-30T00:00:00.000Z";

    expect(validateCandidateSnapshot(snapshot)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([{ code: "invalid_timestamp", contactId: "a" }]),
    });
  });

  it("rejects a whitespace-only directoryId", () => {
    const snapshot = { ...baseSnapshot(), directoryId: "   " };

    expect(validateCandidateSnapshot(snapshot)).toMatchObject({ ok: false, issues: [{ code: "invalid_directory_id" }] });
  });

  it("rejects a whitespace-only contact id", () => {
    const snapshot = baseSnapshot();
    snapshot.contacts.get("a")!.id = "   ";

    expect(validateCandidateSnapshot(snapshot)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([{ code: "invalid_contact_id", contactId: "   " }]),
    });
  });

  it("rejects a whitespace-only tombstone contactId", () => {
    const snapshot = baseSnapshot();
    snapshot.tombstones.set("b", {
      contactId: "   ",
      username: "bob",
      createdAt: "2026-01-01T00:00:00.000Z",
      deletedAt: "2026-01-02T00:00:00.000Z",
      reason: "user_deleted",
    });

    expect(validateCandidateSnapshot(snapshot)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([{ code: "invalid_contact_id", contactId: "   " }]),
    });
  });

  it("rejects a non-canonical nickname with leading/trailing whitespace, even though normalizeNickname would not throw on it", () => {
    const snapshot = baseSnapshot();
    snapshot.contacts.get("a")!.nickname = " Alice ";

    expect(validateCandidateSnapshot(snapshot)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([{ code: "invalid_nickname", contactId: "a" }]),
    });
  });

  it("rejects a contact whose Map key does not match its own id", () => {
    const snapshot = baseSnapshot();
    const contact = snapshot.contacts.get("a")!;
    snapshot.contacts.delete("a");
    snapshot.contacts.set("wrong-key", contact); // contact.id is still "a"

    expect(validateCandidateSnapshot(snapshot)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([{ code: "contact_map_key_mismatch", contactId: "a" }]),
    });
  });

  it("rejects a tombstone whose Map key does not match its own contactId", () => {
    const snapshot = baseSnapshot();
    snapshot.tombstones.set("wrong-key", {
      contactId: "b",
      username: "bob",
      createdAt: "2026-01-01T00:00:00.000Z",
      deletedAt: "2026-01-02T00:00:00.000Z",
      reason: "user_deleted",
    });

    expect(validateCandidateSnapshot(snapshot)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([{ code: "tombstone_map_key_mismatch", contactId: "b" }]),
    });
  });

  it("rejects an unresolvable merged tombstone lineage", () => {
    const snapshot: DirectorySnapshot = {
      directoryId: "dir-1",
      contacts: new Map(),
      tombstones: new Map([
        [
          "dup",
          {
            contactId: "dup",
            username: "dup",
            createdAt: "2026-01-01T00:00:00.000Z",
            deletedAt: "2026-01-02T00:00:00.000Z",
            reason: "merged",
            mergedIntoContactId: "ghost",
          },
        ],
      ]),
    };

    expect(validateCandidateSnapshot(snapshot)).toMatchObject({ ok: false, issues: [{ code: "broken_merged_lineage" }] });
  });
});
