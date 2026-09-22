import { describe, expect, expectTypeOf, it } from "vitest";

import type { ThreadContact } from "../../src/domain/contact";
import type { ContactTombstone } from "../../src/domain/tombstone";
import { assertValidTombstone } from "../../src/domain/tombstone";
import type { IdentityConflict } from "../../src/domain/conflict";
import {
  MAX_NICKNAME_LENGTH,
  MAX_NOTE_LENGTH,
  normalizeNickname,
  normalizeNote,
} from "../../src/domain/validation";

describe("V2 active contact shape", () => {
  it("carries no deletion state", () => {
    expectTypeOf<ThreadContact>().not.toHaveProperty("deletedAt");
  });

  it("carries an optional note alongside the required nickname", () => {
    expectTypeOf<ThreadContact>().toHaveProperty("nickname").toEqualTypeOf<string>();
    expectTypeOf<ThreadContact>().toHaveProperty("note").toEqualTypeOf<string | undefined>();
  });
});

describe("V2 tombstone shape", () => {
  it("carries no nickname or note", () => {
    expectTypeOf<ContactTombstone>().not.toHaveProperty("nickname");
    expectTypeOf<ContactTombstone>().not.toHaveProperty("note");
  });

  it("accepts a user_deleted tombstone without mergedIntoContactId", () => {
    expect(() =>
      assertValidTombstone({
        contactId: "c1",
        username: "alice",
        createdAt: "2026-01-01T00:00:00.000Z",
        deletedAt: "2026-01-02T00:00:00.000Z",
        reason: "user_deleted",
      }),
    ).not.toThrow();
  });

  it("requires mergedIntoContactId for a merged tombstone", () => {
    expect(() =>
      assertValidTombstone({
        contactId: "c1",
        username: "alice",
        createdAt: "2026-01-01T00:00:00.000Z",
        deletedAt: "2026-01-02T00:00:00.000Z",
        reason: "merged",
      }),
    ).toThrow();
  });

  it("accepts a merged tombstone with mergedIntoContactId", () => {
    expect(() =>
      assertValidTombstone({
        contactId: "c1",
        username: "alice",
        createdAt: "2026-01-01T00:00:00.000Z",
        deletedAt: "2026-01-02T00:00:00.000Z",
        reason: "merged",
        mergedIntoContactId: "c2",
      }),
    ).not.toThrow();
  });
});

describe("V2 pending-only identity conflict shape", () => {
  it("carries no status property", () => {
    expectTypeOf<IdentityConflict>().not.toHaveProperty("status");
  });
});

describe("nickname validation (1-25)", () => {
  it("has a max length of 25", () => {
    expect(MAX_NICKNAME_LENGTH).toBe(25);
  });

  it("accepts exactly 25 visible characters", () => {
    const nickname = "a".repeat(25);
    expect(normalizeNickname(nickname)).toBe(nickname);
  });

  it("rejects 26 visible characters", () => {
    expect(() => normalizeNickname("a".repeat(26))).toThrow();
  });
});

describe("note validation (<=200)", () => {
  it("has a max length of 200", () => {
    expect(MAX_NOTE_LENGTH).toBe(200);
  });

  it("accepts an empty note", () => {
    expect(normalizeNote("")).toBe("");
  });

  it("accepts exactly 200 visible characters", () => {
    const note = "a".repeat(200);
    expect(normalizeNote(note)).toBe(note);
  });

  it("rejects 201 visible characters", () => {
    expect(() => normalizeNote("a".repeat(201))).toThrow();
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeNote("  hello  ")).toBe("hello");
  });
});
