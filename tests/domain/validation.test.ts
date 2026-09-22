import { describe, expect, it } from "vitest";

import {
  isValidThreadsUserId,
  normalizeNickname,
  normalizeThreadsUserId,
  normalizeUsername,
} from "../../src/domain/validation";

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
