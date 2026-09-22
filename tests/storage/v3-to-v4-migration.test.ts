import { describe, expect, it } from "vitest";

import { migrateStorage, migrateV3ToV4 } from "../../src/storage/migrations";
import type { ExtensionStorageV3 } from "../../src/storage/schema";

function populatedV3(): ExtensionStorageV3 {
  return {
    schemaVersion: 3,
    directory: { directoryId: "dev-directory-1" },
    contacts: {
      "contact-1": {
        id: "contact-1",
        threadsUserId: "123",
        username: "alice",
        nickname: "Alice",
        note: "met at a conference",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        identityUpdatedAt: "2026-01-01T00:00:00.000Z",
      },
    },
    tombstones: {
      "contact-2": {
        contactId: "contact-2",
        username: "bob",
        createdAt: "2026-01-01T00:00:00.000Z",
        deletedAt: "2026-01-03T00:00:00.000Z",
        reason: "user_deleted",
      },
    },
    identityIndex: { "username:alice": "contact-1", "threads:123": "contact-1" },
    identityCache: {
      carol: {
        username: "carol",
        threadsUserId: "999",
        source: "network",
        observedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-02-01T00:00:00.000Z",
      },
    },
    identityConflicts: {
      "conflict-1": {
        id: "conflict-1",
        threadsUserId: "555",
        contactIds: ["contact-3", "contact-4"],
        detectedAt: "2026-01-04T00:00:00.000Z",
      },
    },
    settings: {
      enabled: false,
      nicknameDisplay: { profile: false, feed: true, replies: false, quotes: true },
    },
  };
}

const emptyV3: ExtensionStorageV3 = {
  schemaVersion: 3,
  directory: { directoryId: "dev-directory-empty" },
  contacts: {},
  tombstones: {},
  identityIndex: {},
  identityCache: {},
  identityConflicts: {},
  settings: {
    enabled: true,
    nicknameDisplay: { profile: true, feed: true, replies: true, quotes: true },
  },
};

describe("migrateV3ToV4", () => {
  it("discards the development-only V3 directory content entirely", () => {
    const v4 = migrateV3ToV4(populatedV3());

    expect(v4.directories).toEqual({});
    expect(v4.accountBindings).toEqual({});
  });

  it("never assigns V3 data to a Threads account - accountBindings starts empty even with populated V3 contacts", () => {
    const v4 = migrateV3ToV4(populatedV3());

    expect(Object.keys(v4.accountBindings)).toHaveLength(0);
  });

  it("handles an empty V3 installation the same way", () => {
    const v4 = migrateV3ToV4(emptyV3);

    expect(v4).toEqual({
      schemaVersion: 4,
      directories: {},
      accountBindings: {},
      identityCache: {},
      settings: emptyV3.settings,
    });
  });

  it("preserves settings exactly", () => {
    const v3 = populatedV3();
    const v4 = migrateV3ToV4(v3);

    expect(v4.settings).toEqual(v3.settings);
  });

  it("preserves identityCache exactly", () => {
    const v3 = populatedV3();
    const v4 = migrateV3ToV4(v3);

    expect(v4.identityCache).toEqual(v3.identityCache);
  });
});

describe("migrateStorage: V3 -> V4 via the versioned dispatch", () => {
  it("produces the same result as calling migrateV3ToV4 directly", () => {
    const v3 = populatedV3();

    expect(migrateStorage(v3)).toEqual(migrateV3ToV4(v3));
  });

  it("is idempotent when re-run against already-migrated V4 storage", () => {
    const migratedOnce = migrateStorage(populatedV3());
    const migratedTwice = migrateStorage(migratedOnce);

    expect(migratedTwice).toEqual(migratedOnce);
  });

  it("round-trips a populated V4 snapshot (a real directory, non-empty binding) unchanged", () => {
    const v4 = {
      schemaVersion: 4 as const,
      directories: {
        "dir-a": {
          directoryId: "dir-a",
          contacts: {},
          tombstones: {},
          identityIndex: {},
          identityConflicts: {},
        },
      },
      accountBindings: { "123": "dir-a" },
      identityCache: {},
      settings: emptyV3.settings,
    };

    expect(migrateStorage(v4)).toEqual(v4);
  });
});

describe("readV4: accountBindings numeric-owner contract (Phase 3.5 review, High #4)", () => {
  const directories = {
    "dir-a": { directoryId: "dir-a", contacts: {}, tombstones: {}, identityIndex: {}, identityConflicts: {} },
  };

  it("rejects a binding keyed by a username instead of a numeric Threads user ID", () => {
    expect(() =>
      migrateStorage({ schemaVersion: 4, directories, accountBindings: { alice: "dir-a" } }),
    ).toThrow(/numeric Threads user ID/);
  });

  it("rejects an empty-string owner key", () => {
    expect(() => migrateStorage({ schemaVersion: 4, directories, accountBindings: { "": "dir-a" } })).toThrow(
      /numeric Threads user ID/,
    );
  });

  it("rejects a binding whose target directoryId does not exist in directories", () => {
    expect(() =>
      migrateStorage({ schemaVersion: 4, directories, accountBindings: { "123": "missing-dir" } }),
    ).toThrow(/unknown directory/);
  });

  it("rejects an empty-string directoryId target", () => {
    expect(() => migrateStorage({ schemaVersion: 4, directories, accountBindings: { "123": "" } })).toThrow();
  });

  it("accepts a binding whose numeric owner key targets a real directory", () => {
    expect(() =>
      migrateStorage({ schemaVersion: 4, directories, accountBindings: { "123": "dir-a" } }),
    ).not.toThrow();
  });

  it("rejects a directory record whose key does not match its own directoryId", () => {
    expect(() =>
      migrateStorage({
        schemaVersion: 4,
        directories: { "dir-a": { directoryId: "dir-b", contacts: {}, tombstones: {}, identityIndex: {}, identityConflicts: {} } },
        accountBindings: {},
      }),
    ).toThrow(/Invalid storage collection: directories/);
  });
});
