import { describe, expect, it } from "vitest";

import { resolveDirectoryConflicts } from "../../src/dashboard/directory/resolveDirectoryConflicts";
import type { ThreadContact } from "../../src/domain/contact";
import type { IdentityConflict } from "../../src/domain/conflict";

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

describe("resolveDirectoryConflicts", () => {
  it("returns every contact unchanged when there are no conflicts", () => {
    const alice = contact({ id: "alice" });
    const bob = contact({ id: "bob" });

    const result = resolveDirectoryConflicts([alice, bob], []);

    expect(result.visibleContacts).toEqual([alice, bob]);
    expect(result.pendingConflictByContactId.size).toBe(0);
  });

  it("hides the duplicate and flags the numeric-ID contact as pending", () => {
    const canonical = contact({ id: "canonical", threadsUserId: "123" });
    const duplicate = contact({ id: "duplicate" });
    const conflict: IdentityConflict = {
      id: "conflict-1",
      threadsUserId: "123",
      contactIds: [canonical.id, duplicate.id],
      detectedAt: "2026-01-02T00:00:00.000Z",
    };

    const result = resolveDirectoryConflicts([canonical, duplicate], [conflict]);

    expect(result.visibleContacts).toEqual([canonical]);
    expect(result.pendingConflictByContactId.get(canonical.id)).toBe("conflict-1");
  });

  it("hides every duplicate in a 3+-source conflict, keeping only the canonical row", () => {
    const canonical = contact({ id: "canonical", threadsUserId: "123" });
    const dupA = contact({ id: "dup-a" });
    const dupB = contact({ id: "dup-b" });
    const conflict: IdentityConflict = {
      id: "conflict-1",
      threadsUserId: "123",
      contactIds: [canonical.id, dupA.id, dupB.id],
      detectedAt: "2026-01-02T00:00:00.000Z",
    };

    const result = resolveDirectoryConflicts([canonical, dupA, dupB], [conflict]);

    expect(result.visibleContacts).toEqual([canonical]);
  });

  it("leaves an unrelated active contact untouched", () => {
    const canonical = contact({ id: "canonical", threadsUserId: "123" });
    const duplicate = contact({ id: "duplicate" });
    const unrelated = contact({ id: "unrelated" });
    const conflict: IdentityConflict = {
      id: "conflict-1",
      threadsUserId: "123",
      contactIds: [canonical.id, duplicate.id],
      detectedAt: "2026-01-02T00:00:00.000Z",
    };

    const result = resolveDirectoryConflicts([canonical, duplicate, unrelated], [conflict]);

    expect(result.visibleContacts).toEqual([canonical, unrelated]);
    expect(result.pendingConflictByContactId.has(unrelated.id)).toBe(false);
  });
});
