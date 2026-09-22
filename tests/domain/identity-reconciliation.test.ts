import { describe, expect, it } from "vitest";

import type { ThreadContact } from "../../src/domain/contact";
import type { IdentityConflict } from "../../src/domain/conflict";
import { reconcileIdentityDerivedState } from "../../src/domain/identityReconciliation";

function contact(overrides: Partial<ThreadContact>): ThreadContact {
  return {
    id: overrides.id ?? "contact-1",
    username: "alice",
    nickname: "Alice",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    identityUpdatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("reconcileIdentityDerivedState", () => {
  it("indexes a unique stable ID", () => {
    const a = contact({ id: "a", threadsUserId: "123", username: "alice" });
    const result = reconcileIdentityDerivedState({
      contacts: new Map([["a", a]]),
      existingConflicts: new Map(),
      now: "2026-01-05T00:00:00.000Z",
    });

    expect(result.identityIndex).toEqual({ "username:alice": "a", "threads:123": "a" });
    expect(result.identityConflicts).toEqual({});
  });

  it("creates a new conflict for a fresh collision, and does not index the contested threads key", () => {
    const a = contact({ id: "a", threadsUserId: "123", username: "alice" });
    const b = contact({ id: "b", threadsUserId: "123", username: "alice2" });
    const result = reconcileIdentityDerivedState({
      contacts: new Map([["a", a], ["b", b]]),
      existingConflicts: new Map(),
      now: "2026-01-05T00:00:00.000Z",
    });

    expect(result.identityIndex).not.toHaveProperty("threads:123");
    const conflicts = Object.values(result.identityConflicts);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ threadsUserId: "123", contactIds: ["a", "b"], detectedAt: "2026-01-05T00:00:00.000Z" });
  });

  it("preserves an existing conflict's id and detectedAt when the same source set collides again", () => {
    const a = contact({ id: "a", threadsUserId: "123" });
    const b = contact({ id: "b", threadsUserId: "123" });
    const existing: IdentityConflict = {
      id: "conflict-existing",
      threadsUserId: "123",
      contactIds: ["a", "b"],
      detectedAt: "2020-01-01T00:00:00.000Z",
    };

    const result = reconcileIdentityDerivedState({
      contacts: new Map([["a", a], ["b", b]]),
      existingConflicts: new Map([["conflict-existing", existing]]),
      now: "2026-01-05T00:00:00.000Z",
    });

    expect(result.identityConflicts).toEqual({ "conflict-existing": existing });
  });

  it("removes a conflict whose collision has disappeared", () => {
    const a = contact({ id: "a", threadsUserId: "123" });
    const existing: IdentityConflict = {
      id: "conflict-existing",
      threadsUserId: "123",
      contactIds: ["a", "b"],
      detectedAt: "2020-01-01T00:00:00.000Z",
    };

    const result = reconcileIdentityDerivedState({
      contacts: new Map([["a", a]]),
      existingConflicts: new Map([["conflict-existing", existing]]),
      now: "2026-01-05T00:00:00.000Z",
    });

    expect(result.identityConflicts).toEqual({});
    expect(result.identityIndex["threads:123"]).toBe("a");
  });
});
