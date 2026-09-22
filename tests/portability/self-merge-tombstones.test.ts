import { describe, expect, it } from "vitest";

import type { ContactTombstone } from "../../src/domain/tombstone";
import { mergeContactRecord } from "../../src/portability/selfMerge";

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

describe("user_deleted vs user_deleted (§35)", () => {
  it("newer deletedAt wins", () => {
    const local = tombstone({ deletedAt: "2026-01-01T00:00:00.000Z" });
    const incoming = tombstone({ deletedAt: "2026-01-05T00:00:00.000Z" });

    expect(
      mergeContactRecord({ type: "tombstone", tombstone: local }, { type: "tombstone", tombstone: incoming }),
    ).toEqual({ kind: "resolved", result: { type: "tombstone", tombstone: incoming } });
  });

  it("equal timestamp + identical data -> unchanged", () => {
    const local = tombstone();
    const incoming = tombstone();

    expect(
      mergeContactRecord({ type: "tombstone", tombstone: local }, { type: "tombstone", tombstone: incoming }),
    ).toEqual({ kind: "resolved", result: { type: "tombstone", tombstone: local } });
  });

  it("equal timestamp + divergent stable identity data -> review", () => {
    const local = tombstone({ threadsUserId: "123" });
    const incoming = tombstone({ threadsUserId: "999" });

    expect(
      mergeContactRecord({ type: "tombstone", tombstone: local }, { type: "tombstone", tombstone: incoming }).kind,
    ).toBe("blocking");
  });

  it("equal timestamp + divergent username, no stable IDs -> review", () => {
    const local = tombstone({ username: "alice" });
    const incoming = tombstone({ username: "alice2" });

    expect(
      mergeContactRecord({ type: "tombstone", tombstone: local }, { type: "tombstone", tombstone: incoming }),
    ).toEqual({ kind: "review", issue: { kind: "tombstone_tombstone_lifecycle", contactId: "contact-1" } });
  });
});

describe("merged vs user_deleted (§36)", () => {
  it("merged wins independent of timestamp", () => {
    const merged = tombstone({
      reason: "merged",
      mergedIntoContactId: "canonical",
      deletedAt: "2020-01-01T00:00:00.000Z",
    });
    const deleted = tombstone({ deletedAt: "2099-01-01T00:00:00.000Z" });

    expect(
      mergeContactRecord({ type: "tombstone", tombstone: deleted }, { type: "tombstone", tombstone: merged }),
    ).toEqual({ kind: "resolved", result: { type: "tombstone", tombstone: merged } });
  });
});

describe("merged vs merged (§37)", () => {
  it("same canonical -> newer deletedAt wins", () => {
    const local = tombstone({ reason: "merged", mergedIntoContactId: "canonical", deletedAt: "2026-01-01T00:00:00.000Z" });
    const incoming = tombstone({ reason: "merged", mergedIntoContactId: "canonical", deletedAt: "2026-01-05T00:00:00.000Z" });

    expect(
      mergeContactRecord({ type: "tombstone", tombstone: local }, { type: "tombstone", tombstone: incoming }),
    ).toEqual({ kind: "resolved", result: { type: "tombstone", tombstone: incoming } });
  });

  it("different canonical -> blocking, import must not guess", () => {
    const local = tombstone({ reason: "merged", mergedIntoContactId: "canonical-a" });
    const incoming = tombstone({ reason: "merged", mergedIntoContactId: "canonical-b" });

    const result = mergeContactRecord(
      { type: "tombstone", tombstone: local },
      { type: "tombstone", tombstone: incoming },
    );

    expect(result).toMatchObject({ kind: "blocking", issue: { code: "merged_lineage_conflict" } });
  });
});
