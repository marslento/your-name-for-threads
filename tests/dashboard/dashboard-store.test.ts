import { afterEach, describe, expect, it } from "vitest";

import { DashboardStore } from "../../src/dashboard/store/DashboardStore";
import type { ThreadContact } from "../../src/domain/contact";
import type { IdentityConflict } from "../../src/domain/conflict";
import type { DirectoryRecord } from "../../src/domain/directory";
import type { ExtensionStorageV4 } from "../../src/storage/schema";
import { __resetMigrationCoordinatorForTests } from "../../src/storage/migrations";
import { migrationCoordinatorSendMessage } from "../fixtures/storage/migrationCoordinator";

const OWNER = "900";
const OTHER_OWNER = "901";
const DIR_ID = "dir-1";
const OTHER_DIR_ID = "dir-2";
const FLAT_KEYS = ["contacts", "tombstones", "identityIndex", "identityConflicts"] as const;

type StorageChange = { oldValue?: unknown; newValue?: unknown };
type StorageListener = (changes: Record<string, StorageChange>, areaName: string) => void;

function installStorage(directory: Partial<DirectoryRecord> = {}, settings?: Partial<ExtensionStorageV4["settings"]>) {
  let state: ExtensionStorageV4 = {
    schemaVersion: 4,
    directories: {
      [DIR_ID]: { directoryId: DIR_ID, contacts: {}, tombstones: {}, identityIndex: {}, identityConflicts: {}, ...directory },
    },
    accountBindings: { [OWNER]: DIR_ID },
    identityCache: {},
    settings: { enabled: true, nicknameDisplay: { profile: true, feed: true, replies: true, quotes: true }, ...settings },
  };
  const listeners = new Set<StorageListener>();

  const emit = (changes: Record<string, StorageChange>, areaName = "local") => {
    const hasFlat = FLAT_KEYS.some((key) => Object.hasOwn(changes, key));
    let realChanges = changes;
    if (hasFlat) {
      const currentDirectory = state.directories[DIR_ID];
      const oldDirectory = { ...currentDirectory };
      const newDirectory = { ...currentDirectory };
      for (const key of FLAT_KEYS) {
        const change = changes[key];
        if (!change) continue;
        (oldDirectory as unknown as Record<string, unknown>)[key] = change.oldValue ?? (currentDirectory as unknown as Record<string, unknown>)[key];
        (newDirectory as unknown as Record<string, unknown>)[key] = change.newValue ?? {};
      }
      const rest = Object.fromEntries(Object.entries(changes).filter(([key]) => !FLAT_KEYS.includes(key as never)));
      realChanges = {
        ...rest,
        directories: {
          oldValue: { ...state.directories, [DIR_ID]: oldDirectory },
          newValue: { ...state.directories, [DIR_ID]: newDirectory },
        },
      };
      state = { ...state, directories: (realChanges.directories as StorageChange).newValue as ExtensionStorageV4["directories"] };
    }
    for (const listener of [...listeners]) listener(structuredClone(realChanges), areaName);
  };

  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        local: {
          async get() {
            return structuredClone(state);
          },
          async set(values: Record<string, unknown>) {
            state = { ...state, ...structuredClone(values) } as ExtensionStorageV4;
          },
          async remove() {},
        },
        onChanged: {
          addListener(listener: StorageListener) {
            listeners.add(listener);
          },
          removeListener(listener: StorageListener) {
            listeners.delete(listener);
          },
        },
      },
      runtime: { sendMessage: migrationCoordinatorSendMessage() },
    },
  });

  return { emit, listenerCount: () => listeners.size };
}

const alice: ThreadContact = {
  id: "alice-id",
  username: "alice",
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

const conflict: IdentityConflict = {
  id: "conflict-1",
  threadsUserId: "123",
  contactIds: ["alice-id", "bob-id"],
  detectedAt: "2026-01-02T00:00:00.000Z",
};

const defaultSettings = { enabled: true, nicknameDisplay: { profile: true, feed: true, replies: true, quotes: true } };

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
  __resetMigrationCoordinatorForTests();
});

describe("DashboardStore", () => {
  it("loads the initial contacts, conflicts, and settings for the given owner", async () => {
    installStorage({ contacts: { [alice.id]: alice }, identityConflicts: { [conflict.id]: conflict } });
    const store = new DashboardStore();

    await store.start(OWNER);

    expect(store.getContacts()).toEqual([alice]);
    expect(store.getConflicts()).toEqual([conflict]);
    expect(store.getSettings()).toEqual(defaultSettings);
  });

  it("returns empty for an owner with no binding yet", async () => {
    installStorage();
    const store = new DashboardStore();

    await store.start("999");

    expect(store.getContacts()).toEqual([]);
    expect(store.getConflicts()).toEqual([]);
  });

  it("propagates a contact creation to subscribers", async () => {
    const storage = installStorage();
    const store = new DashboardStore();
    let notifications = 0;
    store.subscribe(() => (notifications += 1));
    await store.start(OWNER);
    notifications = 0; // the initial-load notification is covered separately

    storage.emit({ contacts: { newValue: { [alice.id]: alice } } });

    expect(store.getContacts()).toEqual([alice]);
    expect(notifications).toBe(1);
  });

  it("propagates a contact update to subscribers", async () => {
    const storage = installStorage({ contacts: { [alice.id]: alice } });
    const store = new DashboardStore();
    let notifications = 0;
    store.subscribe(() => (notifications += 1));
    await store.start(OWNER);
    notifications = 0; // the initial-load notification is covered separately

    const updated = { ...alice, nickname: "Ally" };
    storage.emit({ contacts: { oldValue: { [alice.id]: alice }, newValue: { [alice.id]: updated } } });

    expect(store.getContacts()).toEqual([updated]);
    expect(notifications).toBe(1);
  });

  it("propagates a contact deletion to subscribers", async () => {
    const storage = installStorage({ contacts: { [alice.id]: alice, [bob.id]: bob } });
    const store = new DashboardStore();
    let notifications = 0;
    store.subscribe(() => (notifications += 1));
    await store.start(OWNER);
    notifications = 0; // the initial-load notification is covered separately

    storage.emit({ contacts: { oldValue: { [alice.id]: alice, [bob.id]: bob }, newValue: { [bob.id]: bob } } });

    expect(store.getContacts()).toEqual([bob]);
    expect(notifications).toBe(1);
  });

  it("updates the pending-conflict count when identityConflicts changes", async () => {
    const storage = installStorage();
    const store = new DashboardStore();
    await store.start(OWNER);
    expect(store.getConflicts()).toEqual([]);

    storage.emit({ identityConflicts: { newValue: { [conflict.id]: conflict } } });
    expect(store.getConflicts()).toEqual([conflict]);

    storage.emit({ identityConflicts: { oldValue: { [conflict.id]: conflict }, newValue: {} } });
    expect(store.getConflicts()).toEqual([]);
  });

  it("updates settings live and notifies subscribers", async () => {
    const storage = installStorage();
    const store = new DashboardStore();
    let notifications = 0;
    store.subscribe(() => (notifications += 1));
    await store.start(OWNER);
    notifications = 0; // the initial-load notification is covered separately

    const nextSettings = {
      enabled: false,
      nicknameDisplay: { profile: false, feed: true, replies: true, quotes: true },
    };
    storage.emit({ settings: { newValue: nextSettings } });

    expect(store.getSettings()).toEqual(nextSettings);
    expect(notifications).toBe(1);
  });

  it("keeps a stable contacts reference when only settings change", async () => {
    const storage = installStorage({ contacts: { [alice.id]: alice } });
    const store = new DashboardStore();
    await store.start(OWNER);
    const before = store.getContacts();

    storage.emit({ settings: { newValue: { enabled: false, nicknameDisplay: defaultSettings.nicknameDisplay } } });

    expect(store.getContacts()).toBe(before);
  });

  it("ignores a directories change that only affects a different owner's directory", async () => {
    const storage = installStorage({ contacts: { [alice.id]: alice } });
    const store = new DashboardStore();
    let notifications = 0;
    store.subscribe(() => (notifications += 1));
    await store.start(OWNER);
    notifications = 0;

    storage.emit({
      directories: {
        newValue: {
          [DIR_ID]: { directoryId: DIR_ID, contacts: { [alice.id]: alice }, tombstones: {}, identityIndex: {}, identityConflicts: {} },
          "dir-other": { directoryId: "dir-other", contacts: { [bob.id]: bob }, tombstones: {}, identityIndex: {}, identityConflicts: {} },
        },
      },
    });

    expect(notifications).toBe(0);
    expect(store.getContacts()).toEqual([alice]);
  });

  it("ignores non-local storage changes", async () => {
    const storage = installStorage();
    const store = new DashboardStore();
    let notifications = 0;
    store.subscribe(() => (notifications += 1));
    await store.start(OWNER);
    notifications = 0; // the initial-load notification is covered separately

    storage.emit({ contacts: { newValue: { [alice.id]: alice } } }, "sync");

    expect(store.getContacts()).toEqual([]);
    expect(notifications).toBe(0);
  });

  it("never lands a stale in-flight load after start(Alice) -> stop() -> start(Bob) (Phase 3.5 review round 2, Critical #2)", async () => {
    const state: ExtensionStorageV4 = {
      schemaVersion: 4,
      directories: {
        [DIR_ID]: { directoryId: DIR_ID, contacts: { [alice.id]: alice }, tombstones: {}, identityIndex: {}, identityConflicts: {} },
        [OTHER_DIR_ID]: { directoryId: OTHER_DIR_ID, contacts: { [bob.id]: bob }, tombstones: {}, identityIndex: {}, identityConflicts: {} },
      },
      accountBindings: { [OWNER]: DIR_ID, [OTHER_OWNER]: OTHER_DIR_ID },
      identityCache: {},
      settings: defaultSettings,
    };
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        storage: {
          local: {
            async get() {
              return structuredClone(state);
            },
            async set() {},
            async remove() {},
          },
          onChanged: { addListener() {}, removeListener() {} },
        },
        runtime: { sendMessage: migrationCoordinatorSendMessage() },
      },
    });
    const store = new DashboardStore();

    const aliceStart = store.start(OWNER);
    store.stop();
    await store.start(OTHER_OWNER);
    await aliceStart;

    expect(store.getContacts()).toEqual([bob]);
  });

  it("clears contacts and conflicts on stop() - they do not linger for a subsequent getter call", async () => {
    installStorage({ contacts: { [alice.id]: alice }, identityConflicts: { [conflict.id]: conflict } });
    const store = new DashboardStore();
    await store.start(OWNER);
    expect(store.getContacts()).toEqual([alice]);

    store.stop();

    expect(store.getContacts()).toEqual([]);
    expect(store.getConflicts()).toEqual([]);
    expect(store.isLoaded()).toBe(false);
  });

  it("adds and removes exactly one storage listener across idempotent start/stop", async () => {
    const storage = installStorage();
    const store = new DashboardStore();

    await store.start(OWNER);
    await store.start(OWNER);
    expect(storage.listenerCount()).toBe(1);

    store.stop();
    store.stop();
    expect(storage.listenerCount()).toBe(0);
  });

  it("notifies a subscriber that subscribed before the initial load resolved", async () => {
    installStorage({ contacts: { [alice.id]: alice } });
    const store = new DashboardStore();
    let notifications = 0;
    store.subscribe(() => (notifications += 1));

    expect(store.isLoaded()).toBe(false);
    await store.start(OWNER);

    expect(store.isLoaded()).toBe(true);
    expect(store.getContacts()).toEqual([alice]);
    expect(notifications).toBe(1);
  });
});
