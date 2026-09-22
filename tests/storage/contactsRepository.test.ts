import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserStorageContactsRepository } from "../../src/storage/BrowserStorageContactsRepository";
import type { ExtensionStorageV4 } from "../../src/storage/schema";
import { __resetMigrationCoordinatorForTests } from "../../src/storage/migrations";
import { type FakeStorageArea, installFakeChrome } from "../fixtures/storage/fakeChromeStorage";
import { migrationCoordinatorSendMessage } from "../fixtures/storage/migrationCoordinator";

const OWNER = "900";

type StorageArea = FakeStorageArea;

function installStorage(initial: Record<string, unknown> = {}): StorageArea {
  return installFakeChrome(initial, migrationCoordinatorSendMessage());
}

function boundDirectory(area: StorageArea, owner = OWNER) {
  const snap = area.snapshot() as ExtensionStorageV4;
  const dirId = snap.accountBindings[owner];
  return dirId ? snap.directories[dirId] : undefined;
}

function requireDirectory(area: StorageArea, owner = OWNER) {
  const directory = boundDirectory(area, owner);
  if (!directory) throw new Error("expected a bound directory for " + owner);
  return directory;
}

async function writeToDirectory(area: StorageArea, patch: Record<string, unknown>, owner = OWNER) {
  const directory = requireDirectory(area, owner);
  await chrome.storage.local.set({
    directories: { ...(area.snapshot() as ExtensionStorageV4).directories, [directory.directoryId]: { ...directory, ...patch } },
  });
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
  __resetMigrationCoordinatorForTests();
});

describe("BrowserStorageContactsRepository", () => {
  it("creates a normalized active nickname and indexes its identity", async () => {
    const area = installStorage();
    const repository = new BrowserStorageContactsRepository();

    const contact = await repository.upsertNickname(OWNER, {
      identity: { username: " @Alice ", threadsUserId: "123" },
      nickname: "  Alice friend  ",
      now: "2026-01-01T00:00:00.000Z",
    });

    expect(contact).toMatchObject({
      username: "alice",
      threadsUserId: "123",
      nickname: "Alice friend",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      identityUpdatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(contact.id).toEqual(expect.any(String));
    expect(requireDirectory(area).identityIndex).toMatchObject({
      "username:alice": contact.id,
      "threads:123": contact.id,
    });
  });

  it("edits a nickname without replacing preserved contact metadata", async () => {
    const area = installStorage();
    const repository = new BrowserStorageContactsRepository();
    const created = await repository.upsertNickname(OWNER, {
      identity: { username: "alice", threadsUserId: "123" },
      nickname: "Alice",
      now: "2026-01-01T00:00:00.000Z",
    });
    const directory = requireDirectory(area);
    const contacts = { ...directory.contacts, [created.id]: { ...directory.contacts[created.id], note: "Keep this" } };
    await writeToDirectory(area, { contacts });

    const edited = await repository.upsertNickname(OWNER, {
      identity: { username: "@ALICE", threadsUserId: "999" },
      nickname: " Ally ",
      now: "2026-01-02T00:00:00.000Z",
    });

    expect(edited).toMatchObject({
      id: created.id,
      nickname: "Ally",
      note: "Keep this",
      threadsUserId: "123",
      updatedAt: "2026-01-02T00:00:00.000Z",
      identityUpdatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(requireDirectory(area).identityIndex).toMatchObject({ "threads:123": created.id });
    expect(requireDirectory(area).identityIndex["threads:999"]).toBeUndefined();
  });

  it("rejects instead of silently dropping the nickname during an upsert collision", async () => {
    const area = installStorage();
    const repository = new BrowserStorageContactsRepository();
    const numericContact = await repository.upsertNickname(OWNER, {
      identity: { username: "alice", threadsUserId: "123" },
      nickname: "Alice",
      now: "2026-01-01T00:00:00.000Z",
    });
    await repository.upsertNickname(OWNER, {
      identity: { username: "bob" },
      nickname: "Bob",
      now: "2026-01-01T00:00:00.000Z",
    });
    const before = area.snapshot();

    await expect(
      repository.upsertNickname(OWNER, {
        identity: { username: "bob", threadsUserId: "123" },
        nickname: "Bobby",
        now: "2026-01-02T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({
      name: "NicknameIdentityConflictError",
      canonicalContact: numericContact,
    });
    expect(area.snapshot()).toEqual(before);
  });

  it("edits the nickname when username and stable ID resolve to the same contact", async () => {
    installStorage();
    const repository = new BrowserStorageContactsRepository();
    const contact = await repository.upsertNickname(OWNER, {
      identity: { username: "alice", threadsUserId: "123" },
      nickname: "Alice",
      now: "2026-01-01T00:00:00.000Z",
    });

    await expect(
      repository.upsertNickname(OWNER, {
        identity: { username: "alice", threadsUserId: "123" },
        nickname: "Ally",
        now: "2026-01-02T00:00:00.000Z",
      }),
    ).resolves.toEqual({
      ...contact,
      nickname: "Ally",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
  });

  it("rejects an empty supplied Threads ID during nickname upsert", async () => {
    installStorage();
    const repository = new BrowserStorageContactsRepository();

    await expect(
      repository.upsertNickname(OWNER, {
        identity: { username: "alice", threadsUserId: "" },
        nickname: "Alice",
        now: "2026-01-01T00:00:00.000Z",
      }),
    ).rejects.toThrow("Threads user ID must contain ASCII digits only");
  });

  it("rejects an empty supplied Threads ID during identity lookup", async () => {
    installStorage();
    const repository = new BrowserStorageContactsRepository();

    await expect(
      repository.getByIdentity(OWNER, { username: "alice", threadsUserId: "" }),
    ).rejects.toThrow("Threads user ID must contain ASCII digits only");
  });

  it("looks up an active contact by normalized username", async () => {
    installStorage();
    const repository = new BrowserStorageContactsRepository();
    const contact = await repository.upsertNickname(OWNER, {
      identity: { username: "alice" },
      nickname: "Alice",
      now: "2026-01-01T00:00:00.000Z",
    });

    await expect(repository.getByIdentity(OWNER, { username: " @ALICE " })).resolves.toEqual(contact);
  });

  it("looks up an active contact by numeric Threads ID before username", async () => {
    installStorage();
    const repository = new BrowserStorageContactsRepository();
    const byUsername = await repository.upsertNickname(OWNER, {
      identity: { username: "alice" },
      nickname: "Alice",
      now: "2026-01-01T00:00:00.000Z",
    });
    const byId = await repository.upsertNickname(OWNER, {
      identity: { username: "bob", threadsUserId: "123" },
      nickname: "Bob",
      now: "2026-01-01T00:00:00.000Z",
    });

    await expect(
      repository.getByIdentity(OWNER, { username: "alice", threadsUserId: "123" }),
    ).resolves.toEqual(byId);
    expect(byId.id).not.toBe(byUsername.id);
  });

  it("changes the user-owned updatedAt clock when the nickname changes", async () => {
    installStorage();
    const repository = new BrowserStorageContactsRepository();
    await repository.upsertNickname(OWNER, {
      identity: { username: "alice" },
      nickname: "Alice",
      now: "2026-01-01T00:00:00.000Z",
    });

    const edited = await repository.upsertNickname(OWNER, {
      identity: { username: "alice" },
      nickname: "Ally",
      now: "2026-01-02T00:00:00.000Z",
    });

    expect(edited.updatedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("attaches a stable identity without changing the user-owned updatedAt clock", async () => {
    const area = installStorage();
    const repository = new BrowserStorageContactsRepository();
    const contact = await repository.upsertNickname(OWNER, {
      identity: { username: "alice" },
      nickname: "Alice",
      now: "2026-01-01T00:00:00.000Z",
    });

    const result = await repository.attachStableIdentity(OWNER, {
      username: " @ALICE ",
      threadsUserId: "123",
      observedAt: "2026-01-02T00:00:00.000Z",
    });

    expect(result).toEqual({
      type: "attached",
      contact: {
        ...contact,
        threadsUserId: "123",
        identityUpdatedAt: "2026-01-02T00:00:00.000Z",
      },
    });
    expect(requireDirectory(area).identityIndex).toMatchObject({ "threads:123": contact.id });
  });

  it("returns cached-only when a stable identity has no matching nickname", async () => {
    installStorage();
    const repository = new BrowserStorageContactsRepository();

    await expect(
      repository.attachStableIdentity(OWNER, {
        username: "alice",
        threadsUserId: "123",
        observedAt: "2026-01-02T00:00:00.000Z",
      }),
    ).resolves.toEqual({ type: "cached-only" });
  });

  it("persists a pending conflict without changing either contact or any identity index", async () => {
    const area = installStorage();
    const repository = new BrowserStorageContactsRepository();
    const numericContact = await repository.upsertNickname(OWNER, {
      identity: { username: "oldname", threadsUserId: "123" },
      nickname: "攝影師",
      now: "2026-01-01T00:00:00.000Z",
    });
    const usernameContact = await repository.upsertNickname(OWNER, {
      identity: { username: "abc" },
      nickname: "阿明",
      now: "2026-01-01T00:00:00.000Z",
    });
    const before = requireDirectory(area);

    const result = await repository.attachStableIdentity(OWNER, {
      username: "abc",
      threadsUserId: "123",
      observedAt: "2026-01-02T00:00:00.000Z",
    });

    const after = requireDirectory(area);
    const conflicts = Object.values(after.identityConflicts);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      threadsUserId: "123",
      contactIds: [usernameContact.id, numericContact.id].sort(),
      detectedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(result).toEqual({
      type: "conflict",
      canonicalContact: numericContact,
      conflict: conflicts[0],
    });
    expect(JSON.stringify(after.contacts)).toBe(JSON.stringify(before.contacts));
    expect(JSON.stringify(after.identityIndex)).toBe(JSON.stringify(before.identityIndex));
    expect(after.contacts[numericContact.id].nickname).toBe("攝影師");
    expect(after.contacts[usernameContact.id].nickname).toBe("阿明");
  });

  it("reuses the pending conflict for repeated observations of the same contacts", async () => {
    const area = installStorage();
    const repository = new BrowserStorageContactsRepository();
    const numericContact = await repository.upsertNickname(OWNER, {
      identity: { username: "oldname", threadsUserId: "123" },
      nickname: "攝影師",
      now: "2026-01-01T00:00:00.000Z",
    });
    await repository.upsertNickname(OWNER, {
      identity: { username: "abc" },
      nickname: "阿明",
      now: "2026-01-01T00:00:00.000Z",
    });
    await repository.attachStableIdentity(OWNER, {
      username: "abc",
      threadsUserId: "123",
      observedAt: "2026-01-02T00:00:00.000Z",
    });
    const firstConflict = Object.values(requireDirectory(area).identityConflicts)[0];

    await expect(
      repository.attachStableIdentity(OWNER, {
        username: "abc",
        threadsUserId: "123",
        observedAt: "2026-01-03T00:00:00.000Z",
      }),
    ).resolves.toEqual({
      type: "conflict",
      canonicalContact: numericContact,
      conflict: firstConflict,
    });
    expect(Object.values(requireDirectory(area).identityConflicts)).toEqual([firstConflict]);
  });

  it("reports a pending conflict only for a contact actually named in one, without mutating storage", async () => {
    const area = installStorage();
    const repository = new BrowserStorageContactsRepository();
    const stableContact = await repository.upsertNickname(OWNER, {
      identity: { username: "oldname", threadsUserId: "123" },
      nickname: "Stable",
      now: "2026-01-01T00:00:00.000Z",
    });
    const usernameContact = await repository.upsertNickname(OWNER, {
      identity: { username: "alice" },
      nickname: "Username",
      now: "2026-01-01T00:00:00.000Z",
    });
    void stableContact;
    await writeToDirectory(area, {
      identityConflicts: {
        unrelated: {
          id: "unrelated",
          threadsUserId: "999",
          contactIds: [usernameContact.id, "other-contact"],
          detectedAt: "2026-01-02T00:00:00.000Z",
        },
      },
    });
    const before = area.snapshot();
    const write = vi.spyOn(chrome.storage.local, "set");

    await expect(
      repository.hasPendingConflict(OWNER, { username: "alice", threadsUserId: "123" }),
    ).resolves.toBe(false);
    await expect(repository.hasPendingConflict(OWNER, { username: "alice" })).resolves.toBe(true);
    expect(area.snapshot()).toEqual(before);
    expect(write).not.toHaveBeenCalled();
  });

  it("writes and resolves a normalized identity cache entry for 30 days", async () => {
    const area = installStorage();
    const repository = new BrowserStorageContactsRepository();

    await expect(
      repository.cacheIdentityObservation({
        username: " @ALICE ",
        threadsUserId: "123",
        source: "network",
        observedAt: "2026-01-01T12:34:56.789Z",
      }),
    ).resolves.toEqual({
      username: "alice",
      threadsUserId: "123",
      source: "network",
      observedAt: "2026-01-01T12:34:56.789Z",
      expiresAt: "2026-01-31T12:34:56.789Z",
    });
    await expect(
      repository.getCachedIdentity(" @ALICE ", "2026-01-31T12:34:56.788Z"),
    ).resolves.toMatchObject({ threadsUserId: "123" });
    expect((area.snapshot() as ExtensionStorageV4).identityCache).toHaveProperty("alice");
  });

  it("ignores and persistently prunes an expired identity cache entry", async () => {
    const area = installStorage();
    const repository = new BrowserStorageContactsRepository();
    await repository.cacheIdentityObservation({
      username: "alice",
      threadsUserId: "123",
      source: "profile-route",
      observedAt: "2026-01-01T00:00:00.000Z",
    });

    await expect(
      repository.getCachedIdentity("alice", "2026-01-31T00:00:00.000Z"),
    ).resolves.toBeNull();
    expect((area.snapshot() as ExtensionStorageV4).identityCache).toEqual({});
  });

  it("prunes only expired cache entries without removing contact stable identities", async () => {
    const area = installStorage();
    const repository = new BrowserStorageContactsRepository();
    const contact = await repository.upsertNickname(OWNER, {
      identity: { username: "alice", threadsUserId: "123" },
      nickname: "Alice",
      now: "2026-01-01T00:00:00.000Z",
    });
    await repository.cacheIdentityObservation({
      username: "alice",
      threadsUserId: "123",
      source: "network",
      observedAt: "2026-01-01T00:00:00.000Z",
    });
    await repository.cacheIdentityObservation({
      username: "bob",
      threadsUserId: "456",
      source: "network",
      observedAt: "2026-01-20T00:00:00.000Z",
    });

    await expect(repository.pruneIdentityCache("2026-02-01T00:00:00.000Z")).resolves.toBe(1);
    expect((area.snapshot() as ExtensionStorageV4).identityCache).toEqual({
      bob: {
        username: "bob",
        threadsUserId: "456",
        source: "network",
        observedAt: "2026-01-20T00:00:00.000Z",
        expiresAt: "2026-02-19T00:00:00.000Z",
      },
    });
    await expect(repository.getById(OWNER, contact.id)).resolves.toMatchObject({ threadsUserId: "123" });
    expect(requireDirectory(area).identityIndex["threads:123"]).toBe(contact.id);
  });

  it("does not replace a newer cached identity with an older or equal observation", async () => {
    installStorage();
    const repository = new BrowserStorageContactsRepository();
    const newer = await repository.cacheIdentityObservation({
      username: "alice",
      threadsUserId: "456",
      source: "profile-dom",
      observedAt: "2026-01-02T00:00:00.000Z",
    });

    await expect(
      repository.cacheIdentityObservation({
        username: "ALICE",
        threadsUserId: "123",
        source: "network",
        observedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).resolves.toEqual(newer);
    await expect(
      repository.cacheIdentityObservation({
        username: "alice",
        threadsUserId: "999",
        source: "feed-dom",
        observedAt: "2026-01-02T00:00:00.000Z",
      }),
    ).resolves.toEqual(newer);
  });

  it("renames a stable-ID contact on a newer unclaimed username observation", async () => {
    const area = installStorage();
    const repository = new BrowserStorageContactsRepository();
    const contact = await repository.upsertNickname(OWNER, {
      identity: { username: "alice", threadsUserId: "123" },
      nickname: "Ally",
      now: "2026-01-01T00:00:00.000Z",
    });

    await expect(
      repository.attachStableIdentity(OWNER, {
        username: "alice.new",
        threadsUserId: "123",
        observedAt: "2026-01-02T00:00:00.000Z",
      }),
    ).resolves.toEqual({
      type: "already-linked",
      contact: {
        ...contact,
        username: "alice.new",
        identityUpdatedAt: "2026-01-02T00:00:00.000Z",
      },
    });
    expect(requireDirectory(area).identityIndex).toEqual({
      "threads:123": contact.id,
      "username:alice.new": contact.id,
    });
  });

  it("does not restore a stale username key after a newer rename", async () => {
    const area = installStorage();
    const repository = new BrowserStorageContactsRepository();
    const contact = await repository.upsertNickname(OWNER, {
      identity: { username: "alice", threadsUserId: "123" },
      nickname: "Ally",
      now: "2026-01-01T00:00:00.000Z",
    });
    await repository.attachStableIdentity(OWNER, {
      username: "alice.new",
      threadsUserId: "123",
      observedAt: "2026-01-03T00:00:00.000Z",
    });

    await repository.attachStableIdentity(OWNER, {
      username: "alice",
      threadsUserId: "123",
      observedAt: "2026-01-02T00:00:00.000Z",
    });
    await repository.attachStableIdentity(OWNER, {
      username: "alice",
      threadsUserId: "123",
      observedAt: "2026-01-03T00:00:00.000Z",
    });

    await expect(repository.getById(OWNER, contact.id)).resolves.toMatchObject({
      username: "alice.new",
      identityUpdatedAt: "2026-01-03T00:00:00.000Z",
    });
    expect(requireDirectory(area).identityIndex).toEqual({
      "threads:123": contact.id,
      "username:alice.new": contact.id,
    });
  });

  it("keeps two different owners' Directories completely isolated (Phase 3.5 cross-account safety)", async () => {
    const area = installStorage();
    const repository = new BrowserStorageContactsRepository();
    const OTHER_OWNER = "901";

    const aliceContact = await repository.upsertNickname(OWNER, {
      identity: { username: "alice" },
      nickname: "Alice",
      now: "2026-01-01T00:00:00.000Z",
    });
    const bobContact = await repository.upsertNickname(OTHER_OWNER, {
      identity: { username: "bob" },
      nickname: "Bob",
      now: "2026-01-01T00:00:00.000Z",
    });

    expect(boundDirectory(area, OWNER)?.directoryId).not.toBe(boundDirectory(area, OTHER_OWNER)?.directoryId);
    await expect(repository.listActive(OWNER)).resolves.toEqual([aliceContact]);
    await expect(repository.listActive(OTHER_OWNER)).resolves.toEqual([bobContact]);
    await expect(repository.getByIdentity(OWNER, { username: "bob" })).resolves.toBeNull();
    await expect(repository.getByIdentity(OTHER_OWNER, { username: "alice" })).resolves.toBeNull();
  });
});
