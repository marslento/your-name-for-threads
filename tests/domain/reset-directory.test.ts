import { describe, expect, it } from "vitest";

import type { DirectoryRecord } from "../../src/domain/directory";
import { resetDirectory } from "../../src/domain/resetDirectory";

function directory(overrides: Partial<DirectoryRecord> & { directoryId: string }): DirectoryRecord {
  return { contacts: {}, tombstones: {}, identityIndex: {}, identityConflicts: {}, ...overrides };
}

describe("resetDirectory", () => {
  it("rebinds the owner to a brand-new empty Directory", () => {
    const result = resetDirectory({
      ownerThreadsUserId: "123",
      directories: { "dir-old": directory({ directoryId: "dir-old" }) },
      accountBindings: { "123": "dir-old" },
      newDirectoryId: "dir-new",
    });

    expect(result).toMatchObject({
      ok: true,
      newDirectory: { directoryId: "dir-new", contacts: {}, tombstones: {}, identityIndex: {}, identityConflicts: {} },
      accountBindings: { "123": "dir-new" },
    });
  });

  it("removes the old contacts/tombstones/identityConflicts entirely - not merely empties them", () => {
    const old = directory({
      directoryId: "dir-old",
      contacts: { c1: { id: "c1" } as never },
      tombstones: { t1: { contactId: "t1" } as never },
      identityConflicts: { conf1: { id: "conf1" } as never },
    });

    const result = resetDirectory({
      ownerThreadsUserId: "123",
      directories: { "dir-old": old },
      accountBindings: { "123": "dir-old" },
      newDirectoryId: "dir-new",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.directories).not.toHaveProperty("dir-old");
    expect(result.directories["dir-new"]).toEqual({
      directoryId: "dir-new",
      contacts: {},
      tombstones: {},
      identityIndex: {},
      identityConflicts: {},
    });
  });

  it("assigns exactly the given newDirectoryId, never reusing the old one", () => {
    const result = resetDirectory({
      ownerThreadsUserId: "123",
      directories: { "dir-old": directory({ directoryId: "dir-old" }) },
      accountBindings: { "123": "dir-old" },
      newDirectoryId: "dir-new",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.newDirectory.directoryId).toBe("dir-new");
    expect(result.newDirectory.directoryId).not.toBe("dir-old");
  });

  it("refuses with no_directory for an owner who has never had a Directory", () => {
    const result = resetDirectory({
      ownerThreadsUserId: "123",
      directories: {},
      accountBindings: {},
      newDirectoryId: "dir-new",
    });

    expect(result).toEqual({ ok: false, reason: "no_directory" });
  });

  it("refuses with no_directory when the binding points at a directoryId that no longer exists", () => {
    const result = resetDirectory({
      ownerThreadsUserId: "123",
      directories: {},
      accountBindings: { "123": "dir-missing" },
      newDirectoryId: "dir-new",
    });

    expect(result).toEqual({ ok: false, reason: "no_directory" });
  });

  it("refuses with shared_directory when another owner is still bound to the same directoryId (multi-binding guard)", () => {
    const result = resetDirectory({
      ownerThreadsUserId: "123",
      directories: { "dir-shared": directory({ directoryId: "dir-shared" }) },
      accountBindings: { "123": "dir-shared", "456": "dir-shared" },
      newDirectoryId: "dir-new",
    });

    expect(result).toEqual({ ok: false, reason: "shared_directory" });
  });

  it("never mutates the input directories/accountBindings objects", () => {
    const directories = { "dir-old": directory({ directoryId: "dir-old" }) };
    const accountBindings = { "123": "dir-old" };

    resetDirectory({ ownerThreadsUserId: "123", directories, accountBindings, newDirectoryId: "dir-new" });

    expect(directories).toEqual({ "dir-old": directory({ directoryId: "dir-old" }) });
    expect(accountBindings).toEqual({ "123": "dir-old" });
  });

  it("leaves other owners' directories and bindings untouched", () => {
    const result = resetDirectory({
      ownerThreadsUserId: "123",
      directories: {
        "dir-alice": directory({ directoryId: "dir-alice" }),
        "dir-bob": directory({ directoryId: "dir-bob", contacts: { bob: { id: "bob" } as never } }),
      },
      accountBindings: { "123": "dir-alice", "456": "dir-bob" },
      newDirectoryId: "dir-new",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.accountBindings).toEqual({ "123": "dir-new", "456": "dir-bob" });
    expect(result.directories["dir-bob"].contacts).toHaveProperty("bob");
  });
});
