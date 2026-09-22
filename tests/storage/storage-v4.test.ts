import { describe, expect, expectTypeOf, it } from "vitest";

import type { ExtensionStorageV4 } from "../../src/storage/schema";
import type { DirectoryRecord } from "../../src/domain/directory";

function sampleStorage(): ExtensionStorageV4 {
  return {
    schemaVersion: 4,
    directories: {
      "dir-1": {
        directoryId: "dir-1",
        contacts: {},
        tombstones: {},
        identityIndex: {},
        identityConflicts: {},
      },
    },
    accountBindings: { "123": "dir-1" },
    identityCache: {},
    settings: {
      enabled: true,
      nicknameDisplay: { profile: true, feed: true, replies: true, quotes: true },
    },
  };
}

describe("ExtensionStorageV4", () => {
  it("keys directories by directoryId and accountBindings by numeric Threads user ID", () => {
    const storage = sampleStorage();

    expect(storage.directories["dir-1"].directoryId).toBe("dir-1");
    expect(storage.accountBindings["123"]).toBe("dir-1");
    expect(storage.schemaVersion).toBe(4);
  });

  it("no longer carries contacts/tombstones/identityIndex/identityConflicts at storage root", () => {
    expectTypeOf<ExtensionStorageV4>().not.toHaveProperty("contacts");
    expectTypeOf<ExtensionStorageV4>().not.toHaveProperty("tombstones");
    expectTypeOf<ExtensionStorageV4>().not.toHaveProperty("identityIndex");
    expectTypeOf<ExtensionStorageV4>().not.toHaveProperty("identityConflicts");
    expectTypeOf<ExtensionStorageV4>().not.toHaveProperty("directory");

    expect(Object.keys(sampleStorage()).sort()).toEqual([
      "accountBindings",
      "directories",
      "identityCache",
      "schemaVersion",
      "settings",
    ]);
  });

  it("account binding value is a bare directoryId string - no username or other metadata", () => {
    expectTypeOf<ExtensionStorageV4["accountBindings"]>().toEqualTypeOf<Record<string, string>>();
  });

  it("settings and identityCache remain browser-global, unscoped by directory", () => {
    expectTypeOf<ExtensionStorageV4>().toHaveProperty("settings");
    expectTypeOf<ExtensionStorageV4>().toHaveProperty("identityCache");
  });
});

describe("DirectoryRecord", () => {
  it("carries only directory-owned content, independent of any account binding", () => {
    const record: DirectoryRecord = {
      directoryId: "dir-1",
      contacts: {},
      tombstones: {},
      identityIndex: {},
      identityConflicts: {},
    };

    expect(Object.keys(record).sort()).toEqual([
      "contacts",
      "directoryId",
      "identityConflicts",
      "identityIndex",
      "tombstones",
    ]);
  });
});
