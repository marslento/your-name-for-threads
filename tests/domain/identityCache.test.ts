import { describe, expect, it } from "vitest";

import { isIdentityCacheEntryExpired } from "../../src/domain/identityCache";

describe("isIdentityCacheEntryExpired", () => {
  const entry = {
    username: "alice",
    threadsUserId: "123",
    source: "network" as const,
    observedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-31T00:00:00.000Z",
  };

  it("keeps an entry before its expiry instant", () => {
    expect(isIdentityCacheEntryExpired(entry, "2026-01-30T23:59:59.999Z")).toBe(false);
  });

  it("expires an entry at its expiry instant", () => {
    expect(isIdentityCacheEntryExpired(entry, "2026-01-31T00:00:00.000Z")).toBe(true);
  });

  it("treats malformed dates as expired", () => {
    expect(isIdentityCacheEntryExpired({ ...entry, expiresAt: "not-a-date" }, entry.observedAt)).toBe(
      true,
    );
    expect(isIdentityCacheEntryExpired({ ...entry, observedAt: "not-a-date" }, entry.observedAt)).toBe(
      true,
    );
    expect(isIdentityCacheEntryExpired(entry, "not-a-date")).toBe(true);
  });
});
