/**
 * Raw current-version storage for the Recovery tests: Alice (owner 100) and Bob (owner 200), each with a
 * Directory of their own. Built as plain data, the way `chrome.storage.local` hands it back, so a test can
 * damage any part of it.
 */
export const AT = "2026-03-01T00:00:00.000Z";
export const ALICE = "100";
export const BOB = "200";
export const ALICE_DIR = "dir-alice";
export const BOB_DIR = "dir-bob";

export const contact = (id: string, username: string, threadsUserId: string) => ({
  id,
  threadsUserId,
  username,
  nickname: username.toUpperCase(),
  createdAt: AT,
  updatedAt: AT,
  identityUpdatedAt: AT,
});

export const directory = (directoryId: string, extra: Record<string, unknown> = {}) => ({
  directoryId,
  contacts: {},
  tombstones: {},
  identityIndex: {},
  identityConflicts: {},
  ...extra,
});

export function twoAccounts(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 4,
    directories: {
      [ALICE_DIR]: directory(ALICE_DIR, { contacts: { c1: contact("c1", "carol", "300") } }),
      [BOB_DIR]: directory(BOB_DIR, { contacts: { c2: contact("c2", "dave", "400") } }),
    },
    accountBindings: { [ALICE]: ALICE_DIR, [BOB]: BOB_DIR },
    identityCache: {},
    settings: { enabled: true, nicknameDisplay: { profile: true, feed: true, replies: true, quotes: true } },
    ...overrides,
  };
}

export const withDirectory = (id: string, value: unknown, base = twoAccounts()) => ({
  ...base,
  directories: { ...(base.directories as Record<string, unknown>), [id]: value },
});

/** A Directory record the loader rejects, holding text that must never leak or be lost. */
export const DAMAGED_ALICE = {
  directoryId: "not-the-key-it-is-stored-under",
  contacts: { c1: { nickname: "PRIVATE_NICKNAME_PROBE", note: "PRIVATE_NOTE_PROBE" } },
  extraField: { anything: [1, 2, 3] },
};
