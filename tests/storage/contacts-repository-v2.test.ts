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

function requireDirectory(area: FakeStorageArea, owner = OWNER) {
  const snap = area.snapshot() as ExtensionStorageV4;
  const dirId = snap.accountBindings[owner];
  const directory = dirId ? snap.directories[dirId] : undefined;
  if (!directory) throw new Error("expected a bound directory for " + owner);
  return directory;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
  __resetMigrationCoordinatorForTests();
});

describe("BrowserStorageContactsRepository: active contacts + tombstones (V2)", () => {
  it("removes a deleted contact from the active collection and records a minimal tombstone", async () => {
    const area = installStorage();
    const repository = new BrowserStorageContactsRepository();
    const contact = await repository.upsertNickname(OWNER, {
      identity: { username: "alice", threadsUserId: "123" },
      nickname: "Alice",
      now: "2026-01-01T00:00:00.000Z",
    });

    const tombstone = await repository.deleteContact(OWNER, {
      id: contact.id,
      now: "2026-01-02T00:00:00.000Z",
    });

    expect(tombstone).toEqual({
      contactId: contact.id,
      threadsUserId: "123",
      username: "alice",
      createdAt: "2026-01-01T00:00:00.000Z",
      deletedAt: "2026-01-02T00:00:00.000Z",
      reason: "user_deleted",
    });
    expect(tombstone).not.toHaveProperty("nickname");
    expect(tombstone).not.toHaveProperty("note");
    await expect(repository.getById(OWNER, contact.id)).resolves.toBeNull();
    await expect(repository.listActive(OWNER)).resolves.toEqual([]);
    expect(requireDirectory(area).contacts).toEqual({});
    expect(requireDirectory(area).tombstones).toHaveProperty(contact.id);
  });

  it("prunes every identity index entry pointing at a deleted contact", async () => {
    const area = installStorage();
    const repository = new BrowserStorageContactsRepository();
    const contact = await repository.upsertNickname(OWNER, {
      identity: { username: "alice", threadsUserId: "123" },
      nickname: "Alice",
      now: "2026-01-01T00:00:00.000Z",
    });

    await repository.deleteContact(OWNER, { id: contact.id, now: "2026-01-02T00:00:00.000Z" });

    expect(requireDirectory(area).identityIndex).toEqual({});
  });

  it("no longer resolves a deleted contact through the Profile lookup path", async () => {
    installStorage();
    const repository = new BrowserStorageContactsRepository();
    const contact = await repository.upsertNickname(OWNER, {
      identity: { username: "alice" },
      nickname: "Alice",
      now: "2026-01-01T00:00:00.000Z",
    });
    await repository.deleteContact(OWNER, { id: contact.id, now: "2026-01-02T00:00:00.000Z" });

    await expect(repository.getByIdentity(OWNER, { username: "alice" })).resolves.toBeNull();
    await expect(repository.listActive(OWNER)).resolves.toEqual([]);
  });

  it("rejects deleting a contact that does not exist", async () => {
    installStorage();
    const repository = new BrowserStorageContactsRepository();

    await expect(
      repository.deleteContact(OWNER, { id: "missing", now: "2026-01-01T00:00:00.000Z" }),
    ).rejects.toThrow("Contact not found");
  });

  it("writes only nickname/note and updatedAt through the Dashboard-only mutation", async () => {
    const area = installStorage();
    const repository = new BrowserStorageContactsRepository();
    const contact = await repository.upsertNickname(OWNER, {
      identity: { username: "alice", threadsUserId: "123" },
      nickname: "Alice",
      now: "2026-01-01T00:00:00.000Z",
    });

    const updated = await repository.updateContactDetails(OWNER, {
      id: contact.id,
      nickname: "Ally",
      note: "Met at a conference",
      now: "2026-01-02T00:00:00.000Z",
    });

    expect(updated).toEqual({
      ...contact,
      nickname: "Ally",
      note: "Met at a conference",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(requireDirectory(area).contacts[contact.id]).toEqual(updated);
  });

  it("clears an existing note when the Dashboard mutation submits an empty one", async () => {
    installStorage();
    const repository = new BrowserStorageContactsRepository();
    const contact = await repository.upsertNickname(OWNER, {
      identity: { username: "alice" },
      nickname: "Alice",
      now: "2026-01-01T00:00:00.000Z",
    });
    await repository.updateContactDetails(OWNER, {
      id: contact.id,
      nickname: "Alice",
      note: "Temporary note",
      now: "2026-01-02T00:00:00.000Z",
    });

    const cleared = await repository.updateContactDetails(OWNER, {
      id: contact.id,
      nickname: "Alice",
      note: "   ",
      now: "2026-01-03T00:00:00.000Z",
    });

    expect(cleared).not.toHaveProperty("note");
  });

  it("rejects a Dashboard mutation for a contact that does not exist", async () => {
    installStorage();
    const repository = new BrowserStorageContactsRepository();

    await expect(
      repository.updateContactDetails(OWNER, {
        id: "missing",
        nickname: "Alice",
        note: "",
        now: "2026-01-01T00:00:00.000Z",
      }),
    ).rejects.toThrow("Contact not found");
  });

  it("rejects a note over 200 visible characters", async () => {
    installStorage();
    const repository = new BrowserStorageContactsRepository();
    const contact = await repository.upsertNickname(OWNER, {
      identity: { username: "alice" },
      nickname: "Alice",
      now: "2026-01-01T00:00:00.000Z",
    });

    await expect(
      repository.updateContactDetails(OWNER, {
        id: contact.id,
        nickname: "Alice",
        note: "a".repeat(201),
        now: "2026-01-02T00:00:00.000Z",
      }),
    ).rejects.toThrow();
  });
});
