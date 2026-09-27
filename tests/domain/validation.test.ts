import { describe, expect, it } from "vitest";

import {
  countVisibleCharacters,
  isValidThreadsUserId,
  MAX_NICKNAME_LENGTH,
  MAX_NOTE_LENGTH,
  normalizeNickname,
  normalizeNote,
  normalizeThreadsUserId,
  normalizeUsername,
} from "../../src/domain/validation";
import { segmentsPulled } from "../fixtures/segmentsPulled";

describe("countVisibleCharacters", () => {
  it("counts what a person sees as one character as one", () => {
    const accented = `e${String.fromCodePoint(0x301)}`;

    expect(countVisibleCharacters(`👨‍👩‍👧‍👦${accented}阿`)).toBe(3);
  });

  it("stops one past the limit it is given, however long the text (Codex Security scan 0905, finding 2)", () => {
    expect(countVisibleCharacters("a".repeat(25), 25)).toBe(25);
    expect(countVisibleCharacters("a".repeat(1_000_000), 25)).toBe(26);
    expect(countVisibleCharacters("👍🏽".repeat(1_000), 25)).toBe(26);
  });

  it.each([
    ["nickname", () => normalizeNickname("a".repeat(100_000)), MAX_NICKNAME_LENGTH],
    ["note", () => normalizeNote("a".repeat(100_000)), MAX_NOTE_LENGTH],
  ])("reads an oversized %s only to one past its limit before refusing it", (_field, check, limit) => {
    expect(segmentsPulled(() => expect(check).toThrow())).toBe(limit + 1);
  });
});

describe("normalizeNickname", () => {
  it("rejects a nickname that is empty after trimming", () => {
    expect(() => normalizeNickname("   ")).toThrow();
  });

  it("accepts exactly 25 visible characters", () => {
    const nickname = "a".repeat(25);

    expect(normalizeNickname(nickname)).toBe(nickname);
  });

  it("rejects more than 25 visible characters", () => {
    expect(() => normalizeNickname("a".repeat(26))).toThrow();
  });

  it("accepts Chinese characters", () => {
    expect(normalizeNickname("  阿明  ")).toBe("阿明");
  });

  it("counts a family emoji as one visible character", () => {
    const nickname = "👨‍👩‍👧‍👦".repeat(25);

    expect(normalizeNickname(nickname)).toBe(nickname);
  });

  it("accepts symbols and emoji", () => {
    expect(normalizeNickname("★ 📷")).toBe("★ 📷");
  });
});

describe("normalizeUsername", () => {
  it("trims, removes one leading at-sign, and lowercases", () => {
    expect(normalizeUsername("  @Alice  ")).toBe("alice");
  });

  it("removes only one leading at-sign", () => {
    expect(normalizeUsername("@@Alice")).toBe("@alice");
  });

  it("rejects a username that is empty after normalization", () => {
    expect(() => normalizeUsername("  @  ")).toThrow();
  });
});

describe("Threads user ID validation", () => {
  it("accepts ASCII digit strings", () => {
    expect(isValidThreadsUserId("012345")).toBe(true);
    expect(normalizeThreadsUserId("012345")).toBe("012345");
  });

  it.each(["", " 123", "123 ", "+123", "-123", "12.3", "１２３"]) (
    "rejects %j",
    (value) => {
      expect(isValidThreadsUserId(value)).toBe(false);
      expect(() => normalizeThreadsUserId(value)).toThrow();
    },
  );
});
