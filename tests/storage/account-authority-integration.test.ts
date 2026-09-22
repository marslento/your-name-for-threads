// Migrated from the Phase 3.6 independent probes: real authority, repositories and mutation queue.
import { afterEach, expect, it } from "vitest";

import { AccountWriteAuthority } from "../../src/account/AccountWriteAuthority";
import type { AccountResolutionState } from "../../src/account/accountTypes";
import type { CurrentAccountResolver } from "../../src/account/CurrentAccountResolver";
import { BrowserDirectoryRepository } from "../../src/storage/BrowserDirectoryRepository";
import { BrowserStorageContactsRepository } from "../../src/storage/BrowserStorageContactsRepository";
import { __resetDirectoryAccessQueueForTests } from "../../src/storage/directoryAccess";
import { __resetMigrationCoordinatorForTests } from "../../src/storage/migrations";
import { installFakeChrome } from "../fixtures/storage/fakeChromeStorage";

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
  __resetMigrationCoordinatorForTests();
  __resetDirectoryAccessQueueForTests();
});

const OWNER = "900";
const NOW = "2026-09-17T00:00:00.000Z";
const contact = { id: "c1", username: "alice", nickname: "Before", createdAt: NOW, updatedAt: NOW, identityUpdatedAt: NOW };

function storageFixture() {
  return {
    schemaVersion: 4,
    directories: {
      "dir-a": { directoryId: "dir-a", contacts: { c1: contact }, tombstones: {}, identityIndex: { "username:alice": "c1" }, identityConflicts: {} },
    },
    accountBindings: { [OWNER]: "dir-a" },
    identityCache: {},
    settings: { enabled: true, nicknameDisplay: { profile: true, feed: true, replies: true, quotes: true } },
  };
}

class Resolver implements CurrentAccountResolver {
  private state: AccountResolutionState = { state: "confirmed", ownerThreadsUserId: OWNER, ownerUsername: "alice" };
  private readonly listeners = new Set<() => void>();
  getState(): AccountResolutionState {
    return this.state;
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  setState(next: AccountResolutionState) {
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }
}

/** Pauses the storage read that every mutation performs after entering the queue. */
function pauseFirstRead() {
  const original = chrome.storage.local.get.bind(chrome.storage.local);
  let entered!: () => void;
  let release!: () => void;
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let paused = false;
  chrome.storage.local.get = (async (keys?: unknown) => {
    if (paused) return original(keys as never);
    paused = true;
    const snapshot = await original(keys as never);
    entered();
    await gate;
    return snapshot;
  }) as typeof chrome.storage.local.get;
  return { reading, release: () => release() };
}

// Revocation must happen in the resolver's synchronous notification,
// before any UI render can supply a second guard.
it.each([
  ["unresolved", { state: "unresolved" } as AccountResolutionState],
  ["revalidating", { state: "revalidating" } as AccountResolutionState],
  ["other owner", { state: "confirmed", ownerThreadsUserId: "901", ownerUsername: "bob" } as AccountResolutionState],
])("a nickname write in flight is revoked by %s, with no React involved", async (_label, next) => {
  const area = installFakeChrome(storageFixture() as never);
  const resolver = new Resolver();
  const authority = new AccountWriteAuthority(resolver);
  authority.start();
  const contacts = new BrowserStorageContactsRepository((owner) => authority.capture(owner));
  const before = area.snapshot();
  const writesBefore = area.writeCount();
  const gate = pauseFirstRead();

  const pending = contacts.upsertNickname(OWNER, { identity: { username: "alice" }, nickname: "After", now: NOW });
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await gate.reading;
  resolver.setState(next);
  gate.release();
  await rejected;

  expect(area.writeCount()).toBe(writesBefore);
  expect(area.snapshot()).toEqual(before);
  authority.stop();
});

// Reconfirm in the same turn: revoked work stays revoked; only new work may proceed.
it("reconfirming the same owner does not revive the revoked write, but does allow a new one", async () => {
  const area = installFakeChrome(storageFixture() as never);
  const resolver = new Resolver();
  const authority = new AccountWriteAuthority(resolver);
  authority.start();
  const contacts = new BrowserStorageContactsRepository((owner) => authority.capture(owner));
  const before = area.snapshot();
  const gate = pauseFirstRead();

  const pending = contacts.upsertNickname(OWNER, { identity: { username: "alice" }, nickname: "After", now: NOW });
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await gate.reading;
  resolver.setState({ state: "revalidating" });
  resolver.setState({ state: "confirmed", ownerThreadsUserId: OWNER, ownerUsername: "alice" });
  gate.release();
  await rejected;

  expect(area.snapshot()).toEqual(before);

  await contacts.upsertNickname(OWNER, { identity: { username: "alice" }, nickname: "Later", now: NOW });
  const after = area.snapshot() as unknown as { directories: Record<string, { contacts: Record<string, { nickname: string }> }> };
  expect(after.directories["dir-a"].contacts.c1.nickname).toBe("Later");
  authority.stop();
});

// Directory mutations require the same revocation as contact mutations.
it.each(["clear", "commit"] as const)("a %s in flight is revoked and leaves storage untouched", async (operation) => {
  const area = installFakeChrome(storageFixture() as never);
  const resolver = new Resolver();
  const authority = new AccountWriteAuthority(resolver);
  authority.start();
  const directories = new BrowserDirectoryRepository((owner) => authority.capture(owner));
  const before = area.snapshot();
  const writesBefore = area.writeCount();
  const gate = pauseFirstRead();

  const pending =
    operation === "clear"
      ? directories.clearDirectoryForOwner(OWNER)
      : directories.commitOwnerDirectory({
          ownerThreadsUserId: OWNER,
          createDirectoryId: () => "dir-new",
          mutate: (current) => ({ write: true as const, record: { ...current, contacts: {} }, result: "done" }),
        });
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await gate.reading;
  resolver.setState({ state: "unresolved" });
  gate.release();
  await rejected;

  expect(area.writeCount()).toBe(writesBefore);
  expect(area.snapshot()).toEqual(before);
  authority.stop();
});

// Cancellation must release the queue for the next legitimate operation.
it("a revoked write leaves the mutation queue usable for the next legitimate one", async () => {
  const area = installFakeChrome(storageFixture() as never);
  const resolver = new Resolver();
  const authority = new AccountWriteAuthority(resolver);
  authority.start();
  const contacts = new BrowserStorageContactsRepository((owner) => authority.capture(owner));
  const gate = pauseFirstRead();

  const pending = contacts.upsertNickname(OWNER, { identity: { username: "alice" }, nickname: "After", now: NOW });
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await gate.reading;
  resolver.setState({ state: "unresolved" });
  gate.release();
  await rejected;

  resolver.setState({ state: "confirmed", ownerThreadsUserId: OWNER, ownerUsername: "alice" });
  await contacts.updateContactDetails(OWNER, { id: "c1", nickname: "Recovered", note: "", now: NOW });
  const after = area.snapshot() as unknown as { directories: Record<string, { contacts: Record<string, { nickname: string }> }> };
  expect(after.directories["dir-a"].contacts.c1.nickname).toBe("Recovered");
  authority.stop();
});
