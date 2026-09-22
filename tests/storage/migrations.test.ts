import { afterEach, describe, expect, it, vi } from "vitest";

import { __resetMigrationCoordinatorForTests, loadAndMigrateStorage, migrateStorage } from "../../src/storage/migrations";
import type { ExtensionStorageV2, ExtensionStorageV4 } from "../../src/storage/schema";
import { installFakeChrome } from "../fixtures/storage/fakeChromeStorage";
import { migrationCoordinatorSendMessage } from "../fixtures/storage/migrationCoordinator";

const defaultStorage: ExtensionStorageV4 = {
  schemaVersion: 4,
  directories: {},
  accountBindings: {},
  identityCache: {},
  settings: {
    enabled: true,
    nicknameDisplay: { profile: true, feed: true, replies: true, quotes: true },
  },
};

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
  __resetMigrationCoordinatorForTests();
});

/** A complete contact: the loader checks the fields the type requires, so a stand-in for one has to have them. */
const stub = (id: string) => ({ id, username: id, nickname: id, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", identityUpdatedAt: "2026-01-01T00:00:00.000Z" });

describe("migrateStorage", () => {
  it("turns storage without a schema version into the V4 defaults", () => {
    expect(migrateStorage({})).toEqual(defaultStorage);
  });

  it("upgrades a valid V2 shape to V4, discarding its development-only contacts", () => {
    const storage: ExtensionStorageV2 = {
      schemaVersion: 2,
      contacts: {
        "contact-1": {
          id: "contact-1",
          username: "alice",
          nickname: "Alice",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          identityUpdatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
      tombstones: {},
      identityIndex: { "username:alice": "contact-1" },
      identityCache: {},
      identityConflicts: {},
      settings: {
        enabled: false,
        nicknameDisplay: { profile: false, feed: true, replies: false, quotes: true },
      },
    };

    expect(migrateStorage(storage)).toEqual({
      ...defaultStorage,
      settings: storage.settings,
    });
  });

  it("keeps a valid V4 shape unchanged", () => {
    const storage: ExtensionStorageV4 = {
      ...defaultStorage,
      directories: {
        "dir-1": { directoryId: "dir-1", contacts: {}, tombstones: {}, identityIndex: {}, identityConflicts: {} },
      },
      accountBindings: { "123": "dir-1" },
    };

    expect(migrateStorage(storage)).toEqual(storage);
  });

  it("gives storage without a settings field the defaults, including enabled", () => {
    const storage = { schemaVersion: 2, contacts: {}, identityIndex: {} };

    expect(migrateStorage(storage).settings).toEqual(defaultStorage.settings);
  });

  it("fills in only the missing settings fields when settings is partially present", () => {
    const storage = {
      schemaVersion: 2,
      settings: { nicknameDisplay: { feed: false } },
    };

    expect(migrateStorage(storage).settings).toEqual({
      enabled: true,
      nicknameDisplay: { profile: true, feed: false, replies: true, quotes: true },
    });
  });

  it("rejects a non-object settings value", () => {
    expect(() => migrateStorage({ schemaVersion: 2, settings: "nope" })).toThrow(
      "Invalid V2 storage collection: settings",
    );
  });

  it("rejects a future schema version", () => {
    expect(() => migrateStorage({ schemaVersion: 5 })).toThrow(
      "Unsupported storage schema version: 5",
    );
  });

  it("rejects a merged tombstone missing its merge target inside a V4 directory", () => {
    expect(() =>
      migrateStorage({
        schemaVersion: 4,
        directories: {
          "dir-1": {
            directoryId: "dir-1",
            contacts: {},
            tombstones: {
              "contact-1": {
                contactId: "contact-1",
                username: "alice",
                createdAt: "2026-01-01T00:00:00.000Z",
                deletedAt: "2026-01-02T00:00:00.000Z",
                reason: "merged",
              },
            },
            identityIndex: {},
            identityConflicts: {},
          },
        },
        accountBindings: {},
      }),
    ).toThrow("Merged tombstone requires mergedIntoContactId");
  });
});

describe("loadAndMigrateStorage", () => {
  it("reads and persists defaults through chrome.storage.local", async () => {
    const area = installFakeChrome({}, migrationCoordinatorSendMessage());

    const result = await loadAndMigrateStorage();

    expect(result).toEqual(defaultStorage);
    expect(area.snapshot()).toEqual(defaultStorage);
    expect(area.writeCount()).toBe(1);
  });

  it("migrates V2 data, persists the upgraded V4 snapshot exactly once, and removes the legacy root keys", async () => {
    const area = installFakeChrome(
      { schemaVersion: 2, contacts: { "contact-1": stub("contact-1") }, unknown: "keep" },
      migrationCoordinatorSendMessage(),
    );

    const result = await loadAndMigrateStorage();

    expect(result).toEqual(defaultStorage);
    expect(area.writeCount()).toBe(1);
    const snapshot = area.snapshot();
    expect(snapshot).not.toHaveProperty("contacts");
    expect(snapshot).not.toHaveProperty("tombstones");
    expect(snapshot).not.toHaveProperty("identityIndex");
    expect(snapshot).not.toHaveProperty("identityConflicts");
    expect(snapshot).not.toHaveProperty("directory");
    expect(snapshot.unknown).toBe("keep");
    expect(snapshot).toMatchObject(defaultStorage);
  });

  it("normalizes V4 data in the returned value without persisting the normalization", async () => {
    const area = installFakeChrome(
      { schemaVersion: 4, directories: {}, accountBindings: {}, unknown: "keep" },
      migrationCoordinatorSendMessage(),
    );

    const result = await loadAndMigrateStorage();

    expect(result).toEqual(defaultStorage);
    // A read of already-current storage must be a pure read: the stored
    // bytes stay exactly as they were, even though the in-memory result
    // fills in the missing collections/settings.
    expect(area.snapshot()).toEqual({
      schemaVersion: 4,
      directories: {},
      accountBindings: {},
      unknown: "keep",
    });
    expect(area.writeCount()).toBe(0);
  });

  it("does not write when a future schema version is encountered", async () => {
    const area = installFakeChrome({ schemaVersion: 5, unknown: "keep" }, migrationCoordinatorSendMessage());

    await expect(loadAndMigrateStorage()).rejects.toThrow(
      "Unsupported storage schema version: 5",
    );
    expect(area.writeCount()).toBe(0);
    expect(area.snapshot()).toEqual({ schemaVersion: 5, unknown: "keep" });
  });
});

describe("loadAndMigrateStorage: a stale read must not clobber a concurrent write", () => {
  it("never writes back when reading already-current storage, so a stale read cannot race a concurrent delete", async () => {
    const area = installFakeChrome(
      {
        schemaVersion: 4,
        directories: {
          "dir-1": {
            directoryId: "dir-1",
            contacts: { "alice-id": stub("alice-id") },
            tombstones: {},
            identityIndex: {},
            identityConflicts: {},
          },
        },
        accountBindings: { "123": "dir-1" },
      },
      migrationCoordinatorSendMessage(),
    );
    const setSpy = vi.spyOn(chrome.storage.local, "set");

    const stale = await loadAndMigrateStorage();
    expect(stale.directories["dir-1"].contacts).toHaveProperty("alice-id");
    expect(setSpy).not.toHaveBeenCalled();

    // A concurrent write happens after the stale read; nothing from the
    // earlier stale read can land afterward, because it never wrote at all.
    await chrome.storage.local.set({
      directories: {
        "dir-1": {
          directoryId: "dir-1",
          contacts: {},
          tombstones: { "alice-id": { contactId: "alice-id", username: "alice", createdAt: "2026-01-01T00:00:00.000Z", deletedAt: "2026-01-02T00:00:00.000Z", reason: "user_deleted" } },
          identityIndex: {},
          identityConflicts: {},
        },
      },
      accountBindings: { "123": "dir-1" },
    });

    const after = area.snapshot() as ExtensionStorageV4;
    expect(after.directories["dir-1"].contacts).toEqual({});
    expect(after.directories["dir-1"].tombstones).toHaveProperty("alice-id");
  });
});
