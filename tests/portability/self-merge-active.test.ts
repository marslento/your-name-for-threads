import { describe, expect, it } from "vitest";

import type { ThreadContact } from "../../src/domain/contact";
import { mergeActiveContactVersions, mergeActivePrivateData } from "../../src/portability/selfMerge";

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

describe("mergeActivePrivateData", () => {
  it("newer updatedAt wins", () => {
    const local = contact({ nickname: "Local", updatedAt: "2026-01-02T00:00:00.000Z" });
    const incoming = contact({ nickname: "Incoming", updatedAt: "2026-01-01T00:00:00.000Z" });

    const result = mergeActivePrivateData(local, incoming);

    expect(result).toEqual({
      kind: "resolved",
      value: { nickname: "Local", note: undefined, updatedAt: "2026-01-02T00:00:00.000Z" },
    });
  });

  it("incoming wins when it is newer", () => {
    const local = contact({ nickname: "Local", updatedAt: "2026-01-01T00:00:00.000Z" });
    const incoming = contact({ nickname: "Incoming", updatedAt: "2026-01-02T00:00:00.000Z" });

    expect(mergeActivePrivateData(local, incoming)).toEqual({
      kind: "resolved",
      value: { nickname: "Incoming", note: undefined, updatedAt: "2026-01-02T00:00:00.000Z" },
    });
  });

  it("same updatedAt + same data -> unchanged", () => {
    const local = contact({ nickname: "Alice", note: "hi", updatedAt: "2026-01-01T00:00:00.000Z" });
    const incoming = contact({ nickname: "Alice", note: "hi", updatedAt: "2026-01-01T00:00:00.000Z" });

    expect(mergeActivePrivateData(local, incoming)).toEqual({
      kind: "resolved",
      value: { nickname: "Alice", note: "hi", updatedAt: "2026-01-01T00:00:00.000Z" },
    });
  });

  it("same updatedAt + different nickname -> review", () => {
    const local = contact({ nickname: "Local", updatedAt: "2026-01-01T00:00:00.000Z" });
    const incoming = contact({ nickname: "Incoming", updatedAt: "2026-01-01T00:00:00.000Z" });

    expect(mergeActivePrivateData(local, incoming)).toEqual({
      kind: "review",
      issue: { kind: "active_active_private_data", contactId: "contact-1" },
    });
  });

  it("same updatedAt + different note -> review", () => {
    const local = contact({ note: "a", updatedAt: "2026-01-01T00:00:00.000Z" });
    const incoming = contact({ note: "b", updatedAt: "2026-01-01T00:00:00.000Z" });

    expect(mergeActivePrivateData(local, incoming).kind).toBe("review");
  });
});

describe("mergeActiveContactVersions", () => {
  it("combines identity + private data winners into one contact", () => {
    const local = contact({
      threadsUserId: "123",
      nickname: "Local",
      updatedAt: "2026-01-01T00:00:00.000Z",
      identityUpdatedAt: "2026-01-01T00:00:00.000Z",
    });
    const incoming = contact({
      nickname: "Incoming",
      updatedAt: "2026-01-05T00:00:00.000Z",
      identityUpdatedAt: "2026-01-01T00:00:00.000Z",
    });

    const result = mergeActiveContactVersions(local, incoming);

    expect(result).toEqual({
      kind: "resolved",
      value: contact({
        threadsUserId: "123",
        nickname: "Incoming",
        updatedAt: "2026-01-05T00:00:00.000Z",
        identityUpdatedAt: "2026-01-01T00:00:00.000Z",
      }),
    });
  });
});
