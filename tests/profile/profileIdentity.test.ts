import { describe, expect, it } from "vitest";

import { resolveProfileIdentity } from "../../src/content/surfaces/profile/profileIdentity";

describe("resolveProfileIdentity", () => {
  it("attaches a same-username cached ASCII-digit ID", () => {
    expect(
      resolveProfileIdentity(
        { username: "alice" },
        { username: "@ALICE", threadsUserId: "00123" },
      ),
    ).toEqual({ username: "alice", threadsUserId: "00123" });
  });

  it("ignores malformed cached identity data", () => {
    expect(
      resolveProfileIdentity(
        { username: "alice" },
        { username: "@", threadsUserId: "123" },
      ),
    ).toEqual({ username: "alice" });
  });

  it("ignores a cached ID that cannot be read safely", () => {
    const cachedIdentity = {
      username: "alice",
      get threadsUserId(): never {
        throw new Error("corrupt cached value");
      },
    } as unknown as { username: string; threadsUserId: string };

    expect(() => resolveProfileIdentity({ username: "alice" }, cachedIdentity)).not.toThrow();
    expect(resolveProfileIdentity({ username: "alice" }, cachedIdentity)).toEqual({
      username: "alice",
    });
  });

  it.each([
    { username: "bob", threadsUserId: "123" },
    { username: "alice", threadsUserId: "12.3" },
    { username: "alice", threadsUserId: "１２３" },
  ])("does not attach an untrusted cached identity %#", (cachedIdentity) => {
    expect(resolveProfileIdentity({ username: "alice" }, cachedIdentity)).toEqual({
      username: "alice",
    });
  });

  it("returns a fresh immutable identity", () => {
    const first = resolveProfileIdentity({ username: "alice" });
    const second = resolveProfileIdentity({ username: "alice" });

    expect(first).toEqual({ username: "alice" });
    expect(second).toEqual({ username: "alice" });
    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
  });
});
