import { afterEach, describe, expect, it } from "vitest";

import { BrowserStorageContactsRepository } from "../../src/storage/BrowserStorageContactsRepository";
import type { ExtensionStorageV4 } from "../../src/storage/schema";
import { __resetMigrationCoordinatorForTests } from "../../src/storage/migrations";
import { type FakeStorageArea, installFakeChrome } from "../fixtures/storage/fakeChromeStorage";
import { migrationCoordinatorSendMessage } from "../fixtures/storage/migrationCoordinator";

const OWNER = "900";

function installStorage(initial: Record<string, unknown> = {}): FakeStorageArea {
  return installFakeChrome(initial, migrationCoordinatorSendMessage());
}

function storedTombstones(area: FakeStorageArea, owner = OWNER) {
  const snap = area.snapshot() as ExtensionStorageV4;
  const dirId = snap.accountBindings[owner];
  return dirId ? snap.directories[dirId].tombstones : {};
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
  __resetMigrationCoordinatorForTests();
});

describe("resurrection against V2 tombstones", () => {
  it("resurrects a user_deleted tombstone when the same numeric Threads ID is confirmed", async () => {
    installStorage();
    const repository = new BrowserStorageContactsRepository();
    const created = await repository.upsertNickname(OWNER, {
      identity: { username: "alice", threadsUserId: "123" },
      nickname: "Alice",
      now: "2026-01-01T00:00:00.000Z",
    });
    await repository.deleteContact(OWNER, { id: created.id, now: "2026-01-02T00:00:00.000Z" });

    const resurrected = await repository.upsertNickname(OWNER, {
      identity: { username: "alice", threadsUserId: "123" },
      nickname: "Ally",
      now: "2026-01-03T00:00:00.000Z",
    });

    expect(resurrected).toEqual({
      id: created.id,
      threadsUserId: "123",
      username: "alice",
      nickname: "Ally",
      createdAt: created.createdAt,
      updatedAt: "2026-01-03T00:00:00.000Z",
      identityUpdatedAt: "2026-01-03T00:00:00.000Z",
    });
    expect(resurrected).not.toHaveProperty("note");
  });

  it("removes the tombstone once the contact is resurrected", async () => {
    const area = installStorage();
    const repository = new BrowserStorageContactsRepository();
    const created = await repository.upsertNickname(OWNER, {
      identity: { username: "alice", threadsUserId: "123" },
      nickname: "Alice",
      now: "2026-01-01T00:00:00.000Z",
    });
    await repository.deleteContact(OWNER, { id: created.id, now: "2026-01-02T00:00:00.000Z" });
    expect(storedTombstones(area)).toHaveProperty(created.id);

    await repository.upsertNickname(OWNER, {
      identity: { username: "alice", threadsUserId: "123" },
      nickname: "Ally",
      now: "2026-01-03T00:00:00.000Z",
    });

    expect(storedTombstones(area)).not.toHaveProperty(created.id);
  });

  it("does not resurrect a username-only tombstone lacking numeric Threads ID evidence", async () => {
    const area = installStorage();
    const repository = new BrowserStorageContactsRepository();
    const created = await repository.upsertNickname(OWNER, {
      identity: { username: "alice" },
      nickname: "Alice",
      now: "2026-01-01T00:00:00.000Z",
    });
    await repository.deleteContact(OWNER, { id: created.id, now: "2026-01-02T00:00:00.000Z" });

    const recreated = await repository.upsertNickname(OWNER, {
      identity: { username: "alice" },
      nickname: "Ally",
      now: "2026-01-03T00:00:00.000Z",
    });

    expect(recreated.id).not.toBe(created.id);
    expect(recreated.createdAt).toBe("2026-01-03T00:00:00.000Z");
    expect(storedTombstones(area)).toHaveProperty(created.id);
  });

  it("never resurrects a merged tombstone even when its numeric Threads ID is confirmed again", async () => {
    const dirId = "dir-1";
    const area = installStorage({
      schemaVersion: 4,
      directories: {
        [dirId]: {
          directoryId: dirId,
          contacts: {},
          tombstones: {
            "merged-contact": {
              contactId: "merged-contact",
              threadsUserId: "999",
              username: "old-alice",
              createdAt: "2025-12-01T00:00:00.000Z",
              deletedAt: "2025-12-02T00:00:00.000Z",
              reason: "merged",
              mergedIntoContactId: "canonical-contact",
            },
          },
          identityIndex: {},
          identityConflicts: {},
        },
      },
      accountBindings: { [OWNER]: dirId },
      identityCache: {},
      settings: {
        enabled: true,
        nicknameDisplay: { profile: true, feed: true, replies: true, quotes: true },
      },
    });
    const repository = new BrowserStorageContactsRepository();

    const created = await repository.upsertNickname(OWNER, {
      identity: { username: "old-alice", threadsUserId: "999" },
      nickname: "Alice",
      now: "2026-01-01T00:00:00.000Z",
    });

    expect(created.id).not.toBe("merged-contact");
    expect(created.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(storedTombstones(area)).toHaveProperty("merged-contact");
    expect(storedTombstones(area)["merged-contact"].reason).toBe("merged");
  });
});
