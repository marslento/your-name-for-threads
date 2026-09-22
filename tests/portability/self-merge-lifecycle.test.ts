import { describe, expect, it } from "vitest";

import type { ThreadContact } from "../../src/domain/contact";
import type { ContactTombstone } from "../../src/domain/tombstone";
import { mergeContactRecord } from "../../src/portability/selfMerge";

function contact(overrides: Partial<ThreadContact> = {}): ThreadContact {
  return {
    id: "contact-1",
    username: "alice",
    nickname: "Alice",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    identityUpdatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function tombstone(overrides: Partial<ContactTombstone> = {}): ContactTombstone {
  return {
    contactId: "contact-1",
    username: "alice",
    createdAt: "2026-01-01T00:00:00.000Z",
    deletedAt: "2026-01-01T00:00:00.000Z",
    reason: "user_deleted",
    ...overrides,
  };
}

describe("active vs user_deleted tombstone (§33)", () => {
  it("newer deletion wins", () => {
    const active = contact({ updatedAt: "2026-01-01T00:00:00.000Z" });
    const deleted = tombstone({ deletedAt: "2026-01-02T00:00:00.000Z" });

    expect(mergeContactRecord({ type: "active", contact: active }, { type: "tombstone", tombstone: deleted })).toEqual(
      { kind: "resolved", result: { type: "tombstone", tombstone: deleted } },
    );
  });

  it("newer active updatedAt is a later resurrection -> active wins", () => {
    const active = contact({ updatedAt: "2026-01-05T00:00:00.000Z" });
    const deleted = tombstone({ deletedAt: "2026-01-01T00:00:00.000Z" });

    expect(mergeContactRecord({ type: "tombstone", tombstone: deleted }, { type: "active", contact: active })).toEqual(
      { kind: "resolved", result: { type: "active", contact: active } },
    );
  });

  it("equal timestamps -> reviewable lifecycle ambiguity", () => {
    const active = contact({ updatedAt: "2026-01-01T00:00:00.000Z" });
    const deleted = tombstone({ deletedAt: "2026-01-01T00:00:00.000Z" });

    expect(mergeContactRecord({ type: "active", contact: active }, { type: "tombstone", tombstone: deleted })).toEqual(
      { kind: "review", issue: { kind: "active_tombstone_lifecycle", contactId: "contact-1" } },
    );
  });
});

describe("active vs user_deleted tombstone: stable identity contradiction", () => {
  it("blocks instead of resolving by timestamp when both sides have a different numeric Threads ID (active newer)", () => {
    const active = contact({ threadsUserId: "123", updatedAt: "2099-01-01T00:00:00.000Z" });
    const deleted = tombstone({ threadsUserId: "999", deletedAt: "2020-01-01T00:00:00.000Z" });

    const result = mergeContactRecord({ type: "active", contact: active }, { type: "tombstone", tombstone: deleted });

    expect(result).toMatchObject({
      kind: "blocking",
      issue: { code: "stable_identity_contradiction", contactId: "contact-1" },
    });
  });

  it("blocks the same way regardless of which side is local vs incoming", () => {
    const active = contact({ threadsUserId: "123", updatedAt: "2020-01-01T00:00:00.000Z" });
    const deleted = tombstone({ threadsUserId: "999", deletedAt: "2099-01-01T00:00:00.000Z" });

    const result = mergeContactRecord({ type: "tombstone", tombstone: deleted }, { type: "active", contact: active });

    expect(result.kind).toBe("blocking");
  });

  it("does not block when only one side has a numeric ID", () => {
    const active = contact({ threadsUserId: "123", updatedAt: "2026-01-05T00:00:00.000Z" });
    const deleted = tombstone({ deletedAt: "2026-01-01T00:00:00.000Z" });

    const result = mergeContactRecord({ type: "active", contact: active }, { type: "tombstone", tombstone: deleted });

    expect(result).toEqual({ kind: "resolved", result: { type: "active", contact: active } });
  });

  it("does not block when both sides share the same numeric ID", () => {
    const active = contact({ threadsUserId: "123", updatedAt: "2026-01-05T00:00:00.000Z" });
    const deleted = tombstone({ threadsUserId: "123", deletedAt: "2026-01-01T00:00:00.000Z" });

    const result = mergeContactRecord({ type: "active", contact: active }, { type: "tombstone", tombstone: deleted });

    expect(result).toEqual({ kind: "resolved", result: { type: "active", contact: active } });
  });
});

describe("active vs merged tombstone (§34/§40)", () => {
  it("merged always wins regardless of timestamps", () => {
    const active = contact({ updatedAt: "2099-01-01T00:00:00.000Z" });
    const merged = tombstone({
      reason: "merged",
      mergedIntoContactId: "canonical",
      deletedAt: "2020-01-01T00:00:00.000Z",
    });

    expect(mergeContactRecord({ type: "active", contact: active }, { type: "tombstone", tombstone: merged })).toEqual(
      { kind: "resolved", result: { type: "tombstone", tombstone: merged } },
    );
  });
});
