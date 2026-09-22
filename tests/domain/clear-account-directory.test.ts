import { describe, expect, it } from "vitest";

import { clearAccountDirectory } from "../../src/domain/clearAccountDirectory";
import type { DirectoryRecord } from "../../src/domain/directory";

const ALICE = "900";
const BOB = "901";

function directory(directoryId: string, contactId: string): DirectoryRecord {
  return {
    directoryId,
    contacts: {
      [contactId]: {
        id: contactId,
        username: contactId,
        nickname: "Name",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        identityUpdatedAt: "2026-01-01T00:00:00.000Z",
      },
    },
    tombstones: {},
    identityIndex: {},
    identityConflicts: {},
  };
}

function twoAccounts() {
  return {
    directories: { "dir-alice": directory("dir-alice", "a1"), "dir-bob": directory("dir-bob", "b1") },
    accountBindings: { [ALICE]: "dir-alice", [BOB]: "dir-bob" },
  };
}

describe("clearAccountDirectory (Phase 3.6 §25/§26)", () => {
  it("deletes only the current account's binding and Directory", () => {
    const result = clearAccountDirectory({ ownerThreadsUserId: ALICE, ...twoAccounts() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.directories)).toEqual(["dir-bob"]);
    expect(result.accountBindings).toEqual({ [BOB]: "dir-bob" });
  });

  /** The one failure mode that would make this action unsafe (checklist #26). */
  it("leaves the other account's Directory byte-identical", () => {
    const before = twoAccounts();
    const result = clearAccountDirectory({ ownerThreadsUserId: ALICE, ...before });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.directories["dir-bob"]).toEqual(before.directories["dir-bob"]);
  });

  it("does not mutate the inputs it was given", () => {
    const before = twoAccounts();
    clearAccountDirectory({ ownerThreadsUserId: ALICE, ...before });

    expect(Object.keys(before.directories).sort()).toEqual(["dir-alice", "dir-bob"]);
    expect(before.accountBindings).toEqual({ [ALICE]: "dir-alice", [BOB]: "dir-bob" });
  });

  it("refuses when the account has no Directory at all", () => {
    const result = clearAccountDirectory({
      ownerThreadsUserId: ALICE,
      directories: {},
      accountBindings: {},
    });

    expect(result).toEqual({ ok: false, reason: "no_directory" });
  });

  it("refuses when the binding points at a Directory that is not actually stored", () => {
    const result = clearAccountDirectory({
      ownerThreadsUserId: ALICE,
      directories: {},
      accountBindings: { [ALICE]: "dir-missing" },
    });

    expect(result).toEqual({ ok: false, reason: "no_directory" });
  });

  /**
   * v1.0 enforces one account per Directory (Phase 3.6 §3), so this can only
   * come from dev-only data - but clearing it would destroy the other
   * account's contacts, which is precisely what this action promises never
   * to do.
   */
  it("refuses to delete a Directory another account is still bound to", () => {
    const result = clearAccountDirectory({
      ownerThreadsUserId: ALICE,
      directories: { shared: directory("shared", "c1") },
      accountBindings: { [ALICE]: "shared", [BOB]: "shared" },
    });

    expect(result).toEqual({ ok: false, reason: "shared_directory" });
  });
});
