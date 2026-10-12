import { describe, expect, it } from "vitest";

import { assertValidTombstone } from "../../src/domain/tombstone";
import { normalizeNote } from "../../src/domain/validation";

describe("V2 tombstone shape", () => {
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

describe("note validation (<=200)", () => {
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
