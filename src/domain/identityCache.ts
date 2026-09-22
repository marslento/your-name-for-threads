import type { IdentityCacheEntry } from "./identity";

export const IDENTITY_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export function isIdentityCacheEntryExpired(entry: IdentityCacheEntry, now: string): boolean {
  const observedAt = Date.parse(entry.observedAt);
  const expiresAt = Date.parse(entry.expiresAt);
  const checkedAt = Date.parse(now);

  return (
    !Number.isFinite(observedAt) ||
    !Number.isFinite(expiresAt) ||
    !Number.isFinite(checkedAt) ||
    expiresAt <= checkedAt
  );
}
