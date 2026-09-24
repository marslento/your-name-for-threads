import { afterEach, describe, expect, it } from "vitest";

import { ContactStore } from "../../src/storage/ContactStore";
import type { ThreadContact } from "../../src/domain/contact";
import type { IdentityCacheEntry } from "../../src/domain/identity";
import type { ExtensionStorageV4 } from "../../src/storage/schema";
import { __resetMigrationCoordinatorForTests } from "../../src/storage/migrations";
import { migrationCoordinatorSendMessage } from "../fixtures/storage/migrationCoordinator";

type StorageChange = { oldValue?: unknown; newValue?: unknown };
type StorageListener = (changes: Record<string, StorageChange>, areaName: string) => void;

type StorageArea = {
  get(): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  readCount(): number;
};

type StorageFake = {
  area: StorageArea;
  emit(changes: Record<string, StorageChange>, areaName?: string): void;
  listenerCount(): number;
  addCount(): number;
  removeCount(): number;
};

const OWNER = "123";
const OTHER_OWNER = "456";
const DIR_ID = "dir-owner";
const OTHER_DIR_ID = "dir-other";

function v4Storage(overrides: Partial<ExtensionStorageV4> = {}): ExtensionStorageV4 {
  return {
    schemaVersion: 4,
    directories: {},
    accountBindings: {},
    identityCache: {},
    settings: { enabled: true, nicknameDisplay: { profile: true, feed: true, replies: true, quotes: true } },
    ...overrides,
  };
}

function directoryWith(contacts: Record<string, ThreadContact>, identityIndex: Record<string, string>) {
  return { directoryId: DIR_ID, contacts, identityIndex, tombstones: {}, identityConflicts: {} };
}

const alice: ThreadContact = {
  id: "alice-id",
  username: "alice",
  threadsUserId: "123",
  nickname: "Alice",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  identityUpdatedAt: "2026-01-01T00:00:00.000Z",
};

const bob: ThreadContact = {
  id: "bob-id",
  username: "bob",
  nickname: "Bob",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  identityUpdatedAt: "2026-01-01T00:00:00.000Z",
};

function installStorage(initial: ExtensionStorageV4): StorageFake {
  let state = structuredClone(initial) as Record<string, unknown>;
  let reads = 0;
  let adds = 0;
  let removes = 0;
  const listeners = new Set<StorageListener>();

  const emit = (changes: Record<string, StorageChange>, areaName = "local") => {
    for (const listener of [...listeners]) listener(structuredClone(changes), areaName);
  };

  const area: StorageArea = {
    async get() {
      reads += 1;
      return structuredClone(state);
    },
    async set(values) {
      const changes: Record<string, StorageChange> = {};
      for (const [key, value] of Object.entries(values)) {
        if (JSON.stringify(state[key]) !== JSON.stringify(value)) {
          changes[key] = { oldValue: structuredClone(state[key]), newValue: structuredClone(value) };
        }
      }
      state = { ...state, ...structuredClone(values) };
      if (Object.keys(changes).length > 0) emit(changes);
    },
    readCount: () => reads,
  };

  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        local: area,
        onChanged: {
          addListener(listener: StorageListener) {
            adds += 1;
            listeners.add(listener);
          },
          removeListener(listener: StorageListener) {
            removes += 1;
            listeners.delete(listener);
          },
        },
      },
      runtime: { sendMessage: migrationCoordinatorSendMessage() },
    },
  });

  return {
    area,
    emit,
    listenerCount: () => listeners.size,
    addCount: () => adds,
    removeCount: () => removes,
  };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
  __resetMigrationCoordinatorForTests();
});

describe("ContactStore", () => {
  it("does not resolve an ambiguous username introduced by a storage change", async () => {
    const fake = installStorage(v4Storage({
      directories: { [DIR_ID]: directoryWith({ [alice.id]: alice }, { "username:alice": alice.id }) },
      accountBindings: { [OWNER]: DIR_ID },
    }));
    const store = new ContactStore();
    await store.start(OWNER);
    expect(store.getByUsername("alice")?.id).toBe(alice.id);

    const duplicate = { ...bob, username: "alice" };
    await fake.area.set({ directories: { [DIR_ID]: directoryWith(
      { [alice.id]: alice, [duplicate.id]: duplicate }, { "username:alice": duplicate.id },
    ) } });

    expect(store.getByUsername("alice")).toBeNull();
    expect(store.resolve({ username: "alice" })).toBeNull();
    store.stop();
  });

  it.each([false, true])("drops cached private nicknames when the owner binding is removed (directories included: %s)", async (includeDirectories) => {
    const record = directoryWith({ [alice.id]: alice }, { "threads:123": alice.id, "username:alice": alice.id });
    const fake = installStorage(v4Storage({ directories: { [DIR_ID]: record }, accountBindings: { [OWNER]: DIR_ID } }));
    const store = new ContactStore();
    await store.start(OWNER);
    let notifications = 0;
    store.subscribe(() => notifications++);
    expect(store.getByUsername("alice")).toEqual(alice);

    fake.emit({ accountBindings: { newValue: {} }, ...(includeDirectories ? { directories: { newValue: {} } } : {}) });

    expect(store.listActive()).toEqual([]);
    expect(store.getByUsername("alice")).toBeNull();
    expect(store.getByThreadsUserId("123")).toBeNull();
    expect(store.resolve({ username: "alice", threadsUserId: "123" })).toBeNull();
    expect(notifications).toBe(1);
    store.stop();
  });

  it("keeps the current, unexpired username-to-ID cache available synchronously (identityCache is browser-global)", async () => {
    const cachedAlice: IdentityCacheEntry = {
      username: "alice",
      threadsUserId: "123",
      source: "network",
      observedAt: "2026-09-12T00:00:00.000Z",
      expiresAt: "2099-09-12T00:00:00.000Z",
    };
    const fake = installStorage(v4Storage({ identityCache: { alice: cachedAlice } }));
    const store = new ContactStore();
    await store.start(OWNER);

    expect(store.getThreadsUserIdByUsername(" @ALICE ")).toBe("123");

    const cachedBob = { ...cachedAlice, username: "bob", threadsUserId: "456" };
    fake.emit({ identityCache: { oldValue: { alice: cachedAlice }, newValue: { bob: cachedBob } } });

    expect(store.getThreadsUserIdByUsername("alice")).toBeNull();
    expect(store.getThreadsUserIdByUsername("bob")).toBe("456");
  });

  it("returns empty for an owner with no binding yet (never-created Directory)", async () => {
    installStorage(v4Storage());
    const store = new ContactStore();
    await store.start(OWNER);

    expect(store.listActive()).toEqual([]);
    expect(store.getByUsername("alice")).toBeNull();
  });

  it("loads the bound owner's active contacts into synchronous username and stable-ID lookups", async () => {
    installStorage(
      v4Storage({
        directories: {
          [DIR_ID]: directoryWith(
            { [alice.id]: alice, [bob.id]: bob },
            { "username:alice": alice.id, "threads:123": alice.id, "username:bob": bob.id },
          ),
        },
        accountBindings: { [OWNER]: DIR_ID },
      }),
    );
    const store = new ContactStore();

    await store.start(OWNER);

    expect(store.getByThreadsUserId("123")).toEqual(alice);
    expect(store.getByUsername("bob")).toEqual(bob);
    expect(store.listActive()).toEqual([alice, bob]);
  });

  it("does not read storage while resolving a stable ID before a username", async () => {
    const identifiedBob = { ...bob, threadsUserId: "456" };
    const fake = installStorage(
      v4Storage({
        directories: {
          [DIR_ID]: directoryWith(
            { [alice.id]: alice, [bob.id]: identifiedBob },
            { "username:alice": alice.id, "threads:456": bob.id, "username:bob": bob.id },
          ),
        },
        accountBindings: { [OWNER]: DIR_ID },
      }),
    );
    const store = new ContactStore();
    await store.start(OWNER);
    const readsAfterStart = fake.area.readCount();

    expect(store.resolve({ username: "alice", threadsUserId: "456" })).toEqual(identifiedBob);
    expect(store.getByUsername("alice")).toEqual(alice);
    expect(store.listActive()).toEqual([alice, identifiedBob]);
    expect(fake.area.readCount()).toBe(readsAfterStart);
  });

  it("normalizes usernames for direct lookup", async () => {
    installStorage(
      v4Storage({
        directories: { [DIR_ID]: directoryWith({ [alice.id]: alice }, { "username:alice": alice.id }) },
        accountBindings: { [OWNER]: DIR_ID },
      }),
    );
    const store = new ContactStore();
    await store.start(OWNER);

    expect(store.getByUsername(" @ALICE ")).toEqual(alice);
  });

  it("normalizes usernames while resolving an identity", async () => {
    installStorage(
      v4Storage({
        directories: { [DIR_ID]: directoryWith({ [alice.id]: alice }, { "username:alice": alice.id }) },
        accountBindings: { [OWNER]: DIR_ID },
      }),
    );
    const store = new ContactStore();
    await store.start(OWNER);

    expect(store.resolve({ username: " @ALICE " })).toEqual(alice);
  });

  it("applies relevant local changes to its own directory atomically and notifies subscribers once", async () => {
    const fake = installStorage(
      v4Storage({
        directories: { [DIR_ID]: directoryWith({ [alice.id]: alice }, { "username:alice": alice.id }) },
        accountBindings: { [OWNER]: DIR_ID },
      }),
    );
    const store = new ContactStore();
    const notified: (ThreadContact | null)[] = [];
    store.subscribe(() => notified.push(store.getByUsername("bob")));
    await store.start(OWNER);

    fake.emit({
      directories: {
        newValue: { [DIR_ID]: directoryWith({ [bob.id]: bob }, { "username:bob": bob.id }) },
      },
    });

    expect(store.getByUsername("alice")).toBeNull();
    expect(store.getByUsername("bob")).toEqual(bob);
    expect(notified).toEqual([bob]);
  });

  it("ignores a directories change that only affects a DIFFERENT owner's directory (Phase 3.5 cross-owner isolation)", async () => {
    const fake = installStorage(
      v4Storage({
        directories: { [DIR_ID]: directoryWith({ [alice.id]: alice }, { "username:alice": alice.id }) },
        accountBindings: { [OWNER]: DIR_ID },
      }),
    );
    const store = new ContactStore();
    let notifications = 0;
    store.subscribe(() => (notifications += 1));
    await store.start(OWNER);

    // Bob's directory changes in the SAME shared `directories` key - Alice's store must not react.
    fake.emit({
      directories: {
        newValue: {
          [DIR_ID]: directoryWith({ [alice.id]: alice }, { "username:alice": alice.id }),
          [OTHER_DIR_ID]: directoryWith({ [bob.id]: bob }, { "username:bob": bob.id }),
        },
      },
    });

    expect(notifications).toBe(0);
    expect(store.listActive()).toEqual([alice]);
  });

  it("picks up a lazily-created Directory once accountBindings gains this owner's entry", async () => {
    const fake = installStorage(v4Storage());
    const store = new ContactStore();
    let notifications = 0;
    store.subscribe(() => (notifications += 1));
    await store.start(OWNER);
    expect(store.listActive()).toEqual([]);

    // A nickname save elsewhere lazily creates the Directory + binding in one write (Task 7).
    await fake.area.set({
      directories: { [DIR_ID]: directoryWith({ [alice.id]: alice }, { "username:alice": alice.id }) },
      accountBindings: { [OWNER]: DIR_ID },
    });

    expect(store.listActive()).toEqual([alice]);
    expect(notifications).toBeGreaterThan(0);
  });

  it("omits tombstones from every active result (tombstoned contacts never appear in a Directory's contacts map)", async () => {
    installStorage(
      v4Storage({
        directories: { [DIR_ID]: directoryWith({}, {}) },
        accountBindings: { [OWNER]: DIR_ID },
      }),
    );
    const store = new ContactStore();

    await store.start(OWNER);

    expect(store.getByThreadsUserId("123")).toBeNull();
    expect(store.getByUsername("alice")).toBeNull();
    expect(store.resolve({ username: "alice", threadsUserId: "123" })).toBeNull();
    expect(store.listActive()).toEqual([]);
  });

  it("ignores cache-only and non-local changes", async () => {
    const fake = installStorage(
      v4Storage({
        directories: { [DIR_ID]: directoryWith({ [alice.id]: alice }, { "username:alice": alice.id }) },
        accountBindings: { [OWNER]: DIR_ID },
      }),
    );
    const store = new ContactStore();
    let notifications = 0;
    store.subscribe(() => (notifications += 1));
    await store.start(OWNER);

    fake.emit({ identityCache: { oldValue: {}, newValue: { alice: { threadsUserId: "123" } } } });
    fake.emit(
      { directories: { newValue: { [DIR_ID]: directoryWith({ [bob.id]: bob }, { "username:bob": bob.id }) } } },
      "sync",
    );

    expect(store.getByUsername("alice")).toEqual(alice);
    expect(store.getByUsername("bob")).toBeNull();
    expect(notifications).toBe(0);
  });

  it("adds and removes exactly one storage listener across idempotent start and stop calls", async () => {
    const fake = installStorage(v4Storage());
    const store = new ContactStore();

    await store.start(OWNER);
    await store.start(OWNER);
    store.stop();
    store.stop();

    expect(fake.addCount()).toBe(1);
    expect(fake.removeCount()).toBe(1);
    expect(fake.listenerCount()).toBe(0);
  });

  it("makes unsubscribe idempotent", async () => {
    installStorage(
      v4Storage({
        directories: { [DIR_ID]: directoryWith({ [alice.id]: alice }, { "username:alice": alice.id }) },
        accountBindings: { [OWNER]: DIR_ID },
      }),
    );
    const store = new ContactStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => (notifications += 1));
    unsubscribe();
    unsubscribe();
    await store.start(OWNER);

    expect(notifications).toBe(0);
  });

  it("continues notifying after one subscriber throws", async () => {
    const fake = installStorage(
      v4Storage({
        directories: { [DIR_ID]: directoryWith({ [alice.id]: alice }, { "username:alice": alice.id }) },
        accountBindings: { [OWNER]: DIR_ID },
      }),
    );
    const store = new ContactStore();
    let notifications = 0;
    store.subscribe(() => {
      throw new Error("listener failed");
    });
    store.subscribe(() => (notifications += 1));
    await store.start(OWNER);

    fake.emit({ directories: { newValue: { [DIR_ID]: directoryWith({ [bob.id]: bob }, { "username:bob": bob.id }) } } });

    expect(notifications).toBe(1);
    expect(store.getByUsername("bob")).toEqual(bob);
  });

  it("never lands a stale in-flight load after start(Alice) -> stop() -> start(Bob) (Phase 3.5 review round 2, Critical #2)", async () => {
    installStorage(
      v4Storage({
        directories: {
          [DIR_ID]: directoryWith({ [alice.id]: alice }, { "username:alice": alice.id }),
          [OTHER_DIR_ID]: { ...directoryWith({ [bob.id]: bob }, { "username:bob": bob.id }), directoryId: OTHER_DIR_ID },
        },
        accountBindings: { [OWNER]: DIR_ID, [OTHER_OWNER]: OTHER_DIR_ID },
      }),
    );
    const store = new ContactStore();

    // Alice's start() reads storage but the read is never awaited here -
    // stop() and start(Bob) both run while it is still in flight.
    const aliceStart = store.start(OWNER);
    store.stop();
    await store.start(OTHER_OWNER);
    await aliceStart;

    expect(store.getByUsername("alice")).toBeNull();
    expect(store.getByUsername("bob")).toEqual(bob);
    expect(store.listActive()).toEqual([bob]);
  });

  it("clears private contacts, identity indexes, and lookups on stop() - they do not linger for a subsequent getter call", async () => {
    installStorage(
      v4Storage({
        directories: { [DIR_ID]: directoryWith({ [alice.id]: alice }, { "username:alice": alice.id }) },
        accountBindings: { [OWNER]: DIR_ID },
      }),
    );
    const store = new ContactStore();
    await store.start(OWNER);
    expect(store.listActive()).toEqual([alice]);

    store.stop();

    expect(store.listActive()).toEqual([]);
    expect(store.getByUsername("alice")).toBeNull();
    expect(store.getByThreadsUserId("123")).toBeNull();
    expect(store.resolve({ username: "alice" })).toBeNull();
  });

  it("a second start() for a different owner tears down the first owner's data even without an explicit stop()", async () => {
    installStorage(
      v4Storage({
        directories: {
          [DIR_ID]: directoryWith({ [alice.id]: alice }, { "username:alice": alice.id }),
          [OTHER_DIR_ID]: { ...directoryWith({ [bob.id]: bob }, { "username:bob": bob.id }), directoryId: OTHER_DIR_ID },
        },
        accountBindings: { [OWNER]: DIR_ID, [OTHER_OWNER]: OTHER_DIR_ID },
      }),
    );
    const store = new ContactStore();
    await store.start(OWNER);
    expect(store.listActive()).toEqual([alice]);

    await store.start(OTHER_OWNER);

    expect(store.listActive()).toEqual([bob]);
    expect(store.getByUsername("alice")).toBeNull();
  });
});
