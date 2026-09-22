import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserDirectoryRepository } from "../../src/storage/BrowserDirectoryRepository";
import type { ExtensionStorageV4 } from "../../src/storage/schema";
import { type FakeStorageArea, installFakeChrome } from "../fixtures/storage/fakeChromeStorage";

const OWNER = "900";
const DIR_ID = "dir-1";

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
});

function baseline(): ExtensionStorageV4 {
  return {
    schemaVersion: 4,
    directories: { [DIR_ID]: { directoryId: DIR_ID, contacts: {}, tombstones: {}, identityIndex: {}, identityConflicts: {} } },
    accountBindings: { [OWNER]: DIR_ID },
    identityCache: { alice: { username: "alice", threadsUserId: "1", source: "network", observedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2027-01-01T00:00:00.000Z" } },
    settings: { enabled: true, nicknameDisplay: { profile: true, feed: true, replies: true, quotes: true } },
  };
}

function installStorage(initial: ExtensionStorageV4 = baseline()): FakeStorageArea {
  return installFakeChrome(initial);
}

describe("BrowserDirectoryRepository", () => {
  it("reads the owner's bound Directory", async () => {
    installStorage();
    const repository = new BrowserDirectoryRepository();

    const directory = await repository.getDirectoryForOwner(OWNER);

    expect(directory?.directoryId).toBe(DIR_ID);
  });

  it("returns undefined for an owner with no binding, without creating anything", async () => {
    const area = installStorage(baseline());
    const repository = new BrowserDirectoryRepository();

    const directory = await repository.getDirectoryForOwner("999");

    expect(directory).toBeUndefined();
    expect((area.snapshot() as ExtensionStorageV4).accountBindings).not.toHaveProperty("999");
  });

  it("looks up a Directory by id directly", async () => {
    installStorage();
    const repository = new BrowserDirectoryRepository();

    await expect(repository.getDirectoryById(DIR_ID)).resolves.toMatchObject({ directoryId: DIR_ID });
    await expect(repository.getDirectoryById("missing")).resolves.toBeUndefined();
  });

  it("commits contacts/tombstones/identityIndex/identityConflicts for an already-bound owner in exactly one chrome.storage.local.set call", async () => {
    const area = installStorage();
    const setSpy = vi.spyOn(chrome.storage.local, "set");
    const repository = new BrowserDirectoryRepository();

    await repository.commitOwnerDirectory({
      ownerThreadsUserId: OWNER,
      createDirectoryId: () => "unused",
      mutate: (current) => {
        const record = {
          ...current,
          contacts: { a: { id: "a", username: "a", nickname: "A", createdAt: "t", updatedAt: "t", identityUpdatedAt: "t" } },
          identityIndex: { "username:a": "a" },
        };
        return { write: true, record, result: record };
      },
    });

    expect(setSpy).toHaveBeenCalledTimes(1);
    const directory = (area.snapshot() as ExtensionStorageV4).directories[DIR_ID];
    expect(directory).toMatchObject({ contacts: { a: { id: "a" } }, identityIndex: { "username:a": "a" } });
  });

  it("lazily creates the Directory + binding for a never-created owner on first commit", async () => {
    const area = installStorage({ ...baseline(), directories: {}, accountBindings: {} });
    const repository = new BrowserDirectoryRepository();

    await repository.commitOwnerDirectory({
      ownerThreadsUserId: OWNER,
      createDirectoryId: () => "new-dir",
      mutate: (current) => {
        const record = { ...current, contacts: { a: { id: "a" } as never } };
        return { write: true, record, result: record };
      },
    });

    const snapshot = area.snapshot() as ExtensionStorageV4;
    expect(snapshot.accountBindings).toEqual({ [OWNER]: "new-dir" });
    expect(snapshot.directories["new-dir"].contacts).toHaveProperty("a");
  });

  it("never writes settings or identityCache", async () => {
    const area = installStorage();
    const repository = new BrowserDirectoryRepository();

    await repository.commitOwnerDirectory({
      ownerThreadsUserId: OWNER,
      createDirectoryId: () => "unused",
      mutate: (current) => ({ write: true, record: current, result: current }),
    });

    const snapshot = area.snapshot() as ExtensionStorageV4;
    expect(snapshot.settings).toEqual(baseline().settings);
    expect(snapshot.identityCache).toEqual(baseline().identityCache);
  });

  it("keeps two owners' Directories isolated", async () => {
    const otherDirId = "dir-2";
    const area = installStorage({
      ...baseline(),
      directories: {
        ...baseline().directories,
        [otherDirId]: { directoryId: otherDirId, contacts: { b: { id: "b" } as never }, tombstones: {}, identityIndex: {}, identityConflicts: {} },
      },
      accountBindings: { ...baseline().accountBindings, "901": otherDirId },
    });
    const repository = new BrowserDirectoryRepository();

    await repository.commitOwnerDirectory({
      ownerThreadsUserId: OWNER,
      createDirectoryId: () => "unused",
      mutate: (current) => {
        const record = { ...current, contacts: { a: { id: "a" } as never } };
        return { write: true, record, result: record };
      },
    });

    const snapshot = area.snapshot() as ExtensionStorageV4;
    expect(snapshot.directories[otherDirId].contacts).toEqual({ b: { id: "b" } });
    expect(snapshot.directories[DIR_ID].contacts).toEqual({ a: { id: "a" } });
  });
});
