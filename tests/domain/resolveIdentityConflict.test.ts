import { describe, expect, it } from "vitest";

import type { ThreadContact } from "../../src/domain/contact";
import type { IdentityConflict } from "../../src/domain/conflict";
import {
  resolveIdentityConflict,
  type ResolveConflictStorage,
} from "../../src/domain/resolveIdentityConflict";

function contact(overrides: Partial<ThreadContact> & { id: string }): ThreadContact {
  return {
    username: overrides.id,
    nickname: overrides.id,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    identityUpdatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function storageWith(contacts: ThreadContact[], conflict: IdentityConflict): ResolveConflictStorage {
  return {
    contacts: Object.fromEntries(contacts.map((c) => [c.id, c])),
    tombstones: {},
    identityIndex: Object.fromEntries(
      contacts.flatMap((c) => [
        [`username:${c.username}`, c.id],
        ...(c.threadsUserId ? [[`threads:${c.threadsUserId}`, c.id] as [string, string]] : []),
      ]),
    ),
    identityConflicts: { [conflict.id]: conflict },
  };
}

function expectedSourcesFor(contacts: ThreadContact[]) {
  return contacts.map((c) => ({
    contactId: c.id,
    updatedAt: c.updatedAt,
    identityUpdatedAt: c.identityUpdatedAt,
  }));
}

describe("resolveIdentityConflict", () => {
  it("merges a 2-source conflict onto the numeric-ID canonical contact", () => {
    const canonical = contact({ id: "canonical", username: "old", threadsUserId: "123", nickname: "Old" });
    const duplicate = contact({ id: "duplicate", username: "new" });
    const conflict: IdentityConflict = {
      id: "conflict-1",
      threadsUserId: "123",
      contactIds: [canonical.id, duplicate.id],
      detectedAt: "2026-01-02T00:00:00.000Z",
    };
    const storage = storageWith([canonical, duplicate], conflict);

    const result = resolveIdentityConflict(storage, {
      conflictId: conflict.id,
      nickname: "Merged Name",
      note: "Merged note",
      expectedSources: expectedSourcesFor([canonical, duplicate]),
      now: "2026-01-03T00:00:00.000Z",
    });

    expect(result).toEqual({
      type: "resolved",
      contact: {
        id: "canonical",
        threadsUserId: "123",
        username: "old",
        nickname: "Merged Name",
        note: "Merged note",
        createdAt: canonical.createdAt,
        updatedAt: "2026-01-03T00:00:00.000Z",
        identityUpdatedAt: canonical.identityUpdatedAt,
      },
    });
    expect(storage.contacts).toEqual({ canonical: (result as { contact: ThreadContact }).contact });
    expect(storage.identityConflicts).toEqual({});
  });

  it("merges a 3+-source conflict, tombstoning every duplicate", () => {
    const canonical = contact({ id: "canonical", username: "old", threadsUserId: "123" });
    const duplicateA = contact({ id: "dup-a", username: "alias-a" });
    const duplicateB = contact({ id: "dup-b", username: "alias-b" });
    const conflict: IdentityConflict = {
      id: "conflict-1",
      threadsUserId: "123",
      contactIds: [canonical.id, duplicateA.id, duplicateB.id],
      detectedAt: "2026-01-02T00:00:00.000Z",
    };
    const storage = storageWith([canonical, duplicateA, duplicateB], conflict);

    const result = resolveIdentityConflict(storage, {
      conflictId: conflict.id,
      nickname: "Merged",
      note: "",
      expectedSources: expectedSourcesFor([canonical, duplicateA, duplicateB]),
      now: "2026-01-03T00:00:00.000Z",
    });

    expect(result.type).toBe("resolved");
    expect(storage.contacts).toEqual({
      canonical: (result as { contact: ThreadContact }).contact,
    });
    expect(storage.tombstones).toEqual({
      "dup-a": {
        contactId: "dup-a",
        username: "alias-a",
        createdAt: duplicateA.createdAt,
        deletedAt: "2026-01-03T00:00:00.000Z",
        reason: "merged",
        mergedIntoContactId: "canonical",
      },
      "dup-b": {
        contactId: "dup-b",
        username: "alias-b",
        createdAt: duplicateB.createdAt,
        deletedAt: "2026-01-03T00:00:00.000Z",
        reason: "merged",
        mergedIntoContactId: "canonical",
      },
    });
    expect(storage.identityIndex).toEqual({
      "username:old": "canonical",
      "threads:123": "canonical",
    });
    expect(storage.identityConflicts).toEqual({});
  });

  it("picks the source whose threadsUserId exactly matches the conflict, not merely the first numeric-ID source", () => {
    // Regression: the conflict names threadsUserId "123", but the sources
    // are stored with the non-canonical numeric-ID source listed first and
    // the true canonical one second. A "first source with any numeric ID"
    // selection would wrongly treat "wrong-numeric-id" as canonical and
    // tombstone the real "canonical" contact instead.
    const wrongNumericId = contact({ id: "wrong-numeric-id", username: "impostor", threadsUserId: "456" });
    const canonical = contact({ id: "canonical", username: "old", threadsUserId: "123" });
    const conflict: IdentityConflict = {
      id: "conflict-1",
      threadsUserId: "123",
      contactIds: [wrongNumericId.id, canonical.id],
      detectedAt: "2026-01-02T00:00:00.000Z",
    };
    const storage = storageWith([wrongNumericId, canonical], conflict);

    const result = resolveIdentityConflict(storage, {
      conflictId: conflict.id,
      nickname: "Merged",
      note: "",
      expectedSources: expectedSourcesFor([wrongNumericId, canonical]),
      now: "2026-01-03T00:00:00.000Z",
    });

    expect(result.type).toBe("resolved");
    expect(storage.contacts).toHaveProperty("canonical");
    expect(storage.contacts).not.toHaveProperty("wrong-numeric-id");
    expect(storage.tombstones["wrong-numeric-id"]).toMatchObject({ mergedIntoContactId: "canonical" });
  });

  it("rejects a merge when a source was edited since the review page loaded", () => {
    const canonical = contact({ id: "canonical", username: "old", threadsUserId: "123" });
    const duplicate = contact({ id: "duplicate", username: "new" });
    const conflict: IdentityConflict = {
      id: "conflict-1",
      threadsUserId: "123",
      contactIds: [canonical.id, duplicate.id],
      detectedAt: "2026-01-02T00:00:00.000Z",
    };
    const storage = storageWith([canonical, duplicate], conflict);
    const staleExpected = expectedSourcesFor([canonical, duplicate]).map((s) =>
      s.contactId === duplicate.id ? { ...s, updatedAt: "2020-01-01T00:00:00.000Z" } : s,
    );

    const result = resolveIdentityConflict(storage, {
      conflictId: conflict.id,
      nickname: "Merged",
      note: "",
      expectedSources: staleExpected,
      now: "2026-01-03T00:00:00.000Z",
    });

    expect(result).toEqual({ type: "stale" });
    expect(storage.contacts).toEqual({ canonical, duplicate });
    expect(storage.identityConflicts).toEqual({ "conflict-1": conflict });
  });

  it("reports missing when the conflict no longer exists", () => {
    const storage: ResolveConflictStorage = {
      contacts: {},
      tombstones: {},
      identityIndex: {},
      identityConflicts: {},
    };

    const result = resolveIdentityConflict(storage, {
      conflictId: "gone",
      nickname: "Merged",
      note: "",
      expectedSources: [],
      now: "2026-01-03T00:00:00.000Z",
    });

    expect(result).toEqual({ type: "missing" });
  });

  it("reports missing when a source contact was already removed", () => {
    const canonical = contact({ id: "canonical", username: "old", threadsUserId: "123" });
    const conflict: IdentityConflict = {
      id: "conflict-1",
      threadsUserId: "123",
      contactIds: [canonical.id, "vanished"],
      detectedAt: "2026-01-02T00:00:00.000Z",
    };
    const storage = storageWith([canonical], conflict);

    const result = resolveIdentityConflict(storage, {
      conflictId: conflict.id,
      nickname: "Merged",
      note: "",
      expectedSources: expectedSourcesFor([canonical]),
      now: "2026-01-03T00:00:00.000Z",
    });

    expect(result).toEqual({ type: "missing" });
  });

  it("removes the conflict record only once resolved", () => {
    const canonical = contact({ id: "canonical", username: "old", threadsUserId: "123" });
    const duplicate = contact({ id: "duplicate", username: "new" });
    const conflict: IdentityConflict = {
      id: "conflict-1",
      threadsUserId: "123",
      contactIds: [canonical.id, duplicate.id],
      detectedAt: "2026-01-02T00:00:00.000Z",
    };
    const storage = storageWith([canonical, duplicate], conflict);

    resolveIdentityConflict(storage, {
      conflictId: conflict.id,
      nickname: "Merged",
      note: "",
      expectedSources: expectedSourcesFor([canonical, duplicate]),
      now: "2026-01-03T00:00:00.000Z",
    });

    expect(storage.identityConflicts).not.toHaveProperty("conflict-1");
  });
});
