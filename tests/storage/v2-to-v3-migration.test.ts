import { describe, expect, it } from "vitest";

import { migrateV2ToV3 } from "../../src/storage/migrations";
import type { ExtensionStorageV2 } from "../../src/storage/schema";

function populatedV2(): ExtensionStorageV2 {
  return {
    schemaVersion: 2,
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

describe("migrateV2ToV3", () => {
  it("generates a directoryId and preserves every other field unchanged", () => {
    const v2 = populatedV2();
    const v3 = migrateV2ToV3(v2, () => "generated-directory-id");

    expect(v3).toEqual({
      ...v2,
      schemaVersion: 3,
      directory: { directoryId: "generated-directory-id" },
    });
  });

  it("still mints a directoryId for an empty V2 installation", () => {
    const empty: ExtensionStorageV2 = {
      schemaVersion: 2,
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

    const v3 = migrateV2ToV3(empty, () => "generated-directory-id");

    expect(v3.directory).toEqual({ directoryId: "generated-directory-id" });
    expect(v3.contacts).toEqual({});
    expect(v3.tombstones).toEqual({});
  });

  it("calls createDirectoryId exactly once per migration", () => {
    let calls = 0;
    migrateV2ToV3(populatedV2(), () => {
      calls += 1;
      return "id";
    });

    expect(calls).toBe(1);
  });
});
