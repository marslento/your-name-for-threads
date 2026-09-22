import { describe, expect, it } from "vitest";

import type { ThreadContact } from "../../src/domain/contact";
import { mergeActiveIdentitySnapshot } from "../../src/portability/selfMerge";

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

describe("mergeActiveIdentitySnapshot", () => {
  it("both numeric IDs present and different -> blocking", () => {
    const local = contact({ threadsUserId: "123" });
    const incoming = contact({ threadsUserId: "999" });

    const result = mergeActiveIdentitySnapshot(local, incoming);

    expect(result.kind).toBe("blocking");
    expect(result).toMatchObject({
      kind: "blocking",
      issue: { code: "stable_identity_contradiction", contactId: "contact-1" },
    });
  });

  it("both numeric IDs present and equal -> falls through to identityUpdatedAt comparison", () => {
    const local = contact({
      threadsUserId: "123",
      username: "old",
      identityUpdatedAt: "2026-01-01T00:00:00.000Z",
    });
    const incoming = contact({
      threadsUserId: "123",
      username: "new",
      identityUpdatedAt: "2026-01-02T00:00:00.000Z",
    });

    expect(mergeActiveIdentitySnapshot(local, incoming)).toEqual({
      kind: "resolved",
      value: { username: "new", threadsUserId: "123", identityUpdatedAt: "2026-01-02T00:00:00.000Z" },
    });
  });

  it("only local has a numeric ID -> prefer local's stable snapshot even if incoming is newer", () => {
    const local = contact({ threadsUserId: "123", identityUpdatedAt: "2026-01-01T00:00:00.000Z" });
    const incoming = contact({ identityUpdatedAt: "2026-06-01T00:00:00.000Z" });

    expect(mergeActiveIdentitySnapshot(local, incoming)).toEqual({
      kind: "resolved",
      value: { username: "alice", threadsUserId: "123", identityUpdatedAt: "2026-01-01T00:00:00.000Z" },
    });
  });

  it("only incoming has a numeric ID -> prefer incoming's stable snapshot", () => {
    const local = contact({ identityUpdatedAt: "2026-06-01T00:00:00.000Z" });
    const incoming = contact({ threadsUserId: "123", identityUpdatedAt: "2026-01-01T00:00:00.000Z" });

    expect(mergeActiveIdentitySnapshot(local, incoming)).toEqual({
      kind: "resolved",
      value: { username: "alice", threadsUserId: "123", identityUpdatedAt: "2026-01-01T00:00:00.000Z" },
    });
  });

  it("both absent, equal identityUpdatedAt, same username -> unchanged", () => {
    const local = contact();
    const incoming = contact();

    expect(mergeActiveIdentitySnapshot(local, incoming)).toEqual({
      kind: "resolved",
      value: { username: "alice", threadsUserId: undefined, identityUpdatedAt: "2026-01-01T00:00:00.000Z" },
    });
  });

  it("both absent, equal identityUpdatedAt, different username -> review", () => {
    const local = contact({ username: "alice" });
    const incoming = contact({ username: "alice2" });

    expect(mergeActiveIdentitySnapshot(local, incoming)).toEqual({
      kind: "review",
      issue: { kind: "active_active_identity_snapshot", contactId: "contact-1" },
    });
  });

  it("both absent, newer identityUpdatedAt wins", () => {
    const local = contact({ username: "old", identityUpdatedAt: "2026-01-01T00:00:00.000Z" });
    const incoming = contact({ username: "new", identityUpdatedAt: "2026-02-01T00:00:00.000Z" });

    expect(mergeActiveIdentitySnapshot(local, incoming)).toEqual({
      kind: "resolved",
      value: { username: "new", threadsUserId: undefined, identityUpdatedAt: "2026-02-01T00:00:00.000Z" },
    });
  });
});
