import { describe, expect, it } from "vitest";

import type { ExtensionStorageV3 } from "../../src/storage/schema";
import type { DirectorySnapshot } from "../../src/domain/directorySnapshot";

describe("ExtensionStorageV3", () => {
  it("requires directory.directoryId alongside the existing V2 collections", () => {
    const storage: ExtensionStorageV3 = {
      schemaVersion: 3,
      directory: { directoryId: "dir-1" },
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

    expect(storage.directory.directoryId).toBe("dir-1");
    expect(storage.schemaVersion).toBe(3);
  });
});

describe("DirectorySnapshot", () => {
  it("intentionally excludes settings/identityCache/identityIndex/identityConflicts", () => {
    const snapshot: DirectorySnapshot = {
      directoryId: "dir-1",
      contacts: new Map(),
      tombstones: new Map(),
    };

    expect(Object.keys(snapshot).sort()).toEqual(["contacts", "directoryId", "tombstones"]);
  });
});
