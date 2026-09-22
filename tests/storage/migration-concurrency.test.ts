import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetMigrationCoordinatorForTests,
  loadAndMigrateStorage,
  performMigrationOnce,
  STORAGE_MIGRATION_MESSAGE_TYPE,
} from "../../src/storage/migrations";
import type { ExtensionStorageV4 } from "../../src/storage/schema";
import { installFakeChrome } from "../fixtures/storage/fakeChromeStorage";
import { migrationCoordinatorSendMessage } from "../fixtures/storage/migrationCoordinator";

function populatedV2() {
  return {
    schemaVersion: 2,
    contacts: {},
    tombstones: {},
    identityIndex: {},
    identityCache: {},
    identityConflicts: {},
    settings: { enabled: true, nicknameDisplay: { profile: true, feed: true, replies: true, quotes: true } },
  };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
  __resetMigrationCoordinatorForTests();
});

describe("V2 -> V4 migration via the single background-owned coordinator", () => {
  it("routes through chrome.runtime.sendMessage instead of migrating locally when a coordinator is reachable", async () => {
    const area = installFakeChrome(populatedV2(), migrationCoordinatorSendMessage());
    const sendMessageSpy = vi.spyOn(chrome.runtime, "sendMessage");

    await loadAndMigrateStorage();

    expect(sendMessageSpy).toHaveBeenCalledWith({ type: STORAGE_MIGRATION_MESSAGE_TYPE });
    expect(area.writeCount()).toBe(1);
  });

  it("many concurrent callers produce exactly one storage write and one converged V4 result - the exact 'A writes A, B writes B, storage keeps B' interleaving cannot occur because B never performs its own independent migration", async () => {
    const area = installFakeChrome(populatedV2(), migrationCoordinatorSendMessage());

    const results = await Promise.all(Array.from({ length: 5 }, () => loadAndMigrateStorage()));

    expect(area.writeCount()).toBe(1);
    for (const result of results) {
      expect(result).toEqual(results[0]);
    }
    expect(area.snapshot()).toMatchObject(results[0] as unknown as Record<string, unknown>);
  });

  it("performMigrationOnce itself dedupes repeated calls within the same coordinator lifetime (simulating multiple messages arriving at the background)", async () => {
    installFakeChrome(populatedV2(), migrationCoordinatorSendMessage());

    const [a, b, c] = await Promise.all([performMigrationOnce(), performMigrationOnce(), performMigrationOnce()]);

    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it("a caller whose message round-trip lands after a sibling context's write still sees that write, not the snapshot frozen at migration time", async () => {
    const area = installFakeChrome(populatedV2(), migrationCoordinatorSendMessage());

    // Caller A triggers and awaits the migration, then commits a new
    // account binding + directory exactly the way a real context would
    // after loadAndMigrateStorage() resolves - a separate, independent
    // write, never part of the migration coordinator's own promise.
    const resultA = await loadAndMigrateStorage();
    expect(resultA.accountBindings).toEqual({});
    await chrome.storage.local.set({
      directories: {
        "dir-a": { directoryId: "dir-a", contacts: {}, tombstones: {}, identityIndex: {}, identityConflicts: {} },
      },
      accountBindings: { "123": "dir-a" },
    });

    // Caller B's message reaches the (already-settled, already-cleared)
    // coordinator afterward. Under the old design, a coordinator reply that
    // carried the migrated snapshot itself would still show B the empty
    // pre-A-write state, frozen at the moment the FIRST migration resolved
    // - even though real storage has since moved on. B must instead see
    // Alice's binding.
    const resultB = await loadAndMigrateStorage();

    expect(resultB.accountBindings).toEqual({ "123": "dir-a" });
    expect(area.writeCount()).toBe(2); // the migration's own write, then A's independent binding write
  });

  it("a failed migration does not permanently poison the coordinator - the next call can retry", async () => {
    const area = installFakeChrome(populatedV2(), migrationCoordinatorSendMessage());
    const setSpy = vi.spyOn(chrome.storage.local, "set").mockImplementationOnce(() => {
      throw new Error("storage.local.set unavailable");
    });

    await expect(loadAndMigrateStorage()).rejects.toThrow();

    setSpy.mockRestore();
    const result = await loadAndMigrateStorage();

    expect(result.schemaVersion).toBe(4);
    expect(area.writeCount()).toBe(1); // the failed attempt's own (rejected) set call is not counted by the fake, then one successful one
  });

  it("a context with no reachable coordinator throws a retryable error instead of migrating directly", async () => {
    const set = vi.fn(async () => undefined);
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        storage: {
          local: {
            async get() {
              return populatedV2();
            },
            set,
          },
        },
        runtime: {
          async sendMessage() {
            throw new Error("Could not establish connection. Receiving end does not exist.");
          },
        },
      },
    });

    await expect(loadAndMigrateStorage()).rejects.toThrow(/coordinator/i);
    expect(set).not.toHaveBeenCalled();
  });

  it("a context with no chrome.runtime at all throws a retryable error instead of migrating directly", async () => {
    const set = vi.fn(async () => undefined);
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        storage: {
          local: {
            async get() {
              return populatedV2();
            },
            set,
          },
        },
      },
    });

    await expect(loadAndMigrateStorage()).rejects.toThrow(/coordinator/i);
    expect(set).not.toHaveBeenCalled();
  });
});

describe("legacy root key cleanup (Phase 3.5 review, Critical #2)", () => {
  it("removes every V1/V2/V3 private root key once storage lands on V4", async () => {
    const area = installFakeChrome(
      {
        schemaVersion: 3,
        directory: { directoryId: "dev-directory" },
        contacts: { "contact-1": { id: "contact-1" } },
        tombstones: { "contact-2": { contactId: "contact-2" } },
        identityIndex: { "username:alice": "contact-1" },
        identityConflicts: { "conflict-1": { id: "conflict-1" } },
        identityCache: { alice: { username: "alice", threadsUserId: "1", source: "network", observedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-02-01T00:00:00.000Z" } },
        settings: { enabled: true, nicknameDisplay: { profile: true, feed: true, replies: true, quotes: true } },
      },
      migrationCoordinatorSendMessage(),
    );

    await loadAndMigrateStorage();

    const snapshot = area.snapshot();
    expect(snapshot).not.toHaveProperty("directory");
    expect(snapshot).not.toHaveProperty("contacts");
    expect(snapshot).not.toHaveProperty("tombstones");
    expect(snapshot).not.toHaveProperty("identityIndex");
    expect(snapshot).not.toHaveProperty("identityConflicts");
    const v4 = snapshot as unknown as ExtensionStorageV4;
    expect(v4.identityCache).toHaveProperty("alice");
    expect(v4.settings.enabled).toBe(true);
    expect(v4.directories).toEqual({});
    expect(v4.accountBindings).toEqual({});
  });

  it("retries the legacy-key removal on the next call if it failed the first time, without re-discarding settings/identityCache (Phase 3.5 review round 2, Critical #4)", async () => {
    const area = installFakeChrome(
      {
        schemaVersion: 3,
        directory: { directoryId: "dev-directory" },
        contacts: { "contact-1": { id: "contact-1" } },
        tombstones: {},
        identityIndex: {},
        identityConflicts: {},
        identityCache: { alice: { username: "alice", threadsUserId: "1", source: "network", observedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-02-01T00:00:00.000Z" } },
        settings: { enabled: false, nicknameDisplay: { profile: true, feed: true, replies: true, quotes: true } },
      },
      migrationCoordinatorSendMessage(),
    );
    const removeSpy = vi.spyOn(chrome.storage.local, "remove").mockImplementationOnce(() => {
      throw new Error("simulated remove() failure");
    });

    // The first attempt crashes mid-migration: schemaVersion is already 4,
    // but the legacy `contacts` root key is still sitting there because
    // remove() never got to run.
    await expect(loadAndMigrateStorage()).rejects.toThrow("simulated remove() failure");
    expect(area.snapshot()).toHaveProperty("contacts");
    expect((area.snapshot() as unknown as ExtensionStorageV4).schemaVersion).toBe(4);

    removeSpy.mockRestore();
    __resetMigrationCoordinatorForTests();

    // A later call must not treat "schemaVersion is already 4" as done -
    // it retries the cleanup instead of leaving `contacts` orphaned forever.
    const result = await loadAndMigrateStorage();

    const snapshot = area.snapshot();
    expect(snapshot).not.toHaveProperty("contacts");
    expect(snapshot).not.toHaveProperty("directory");
    expect(result.settings.enabled).toBe(false);
    expect(result.identityCache).toHaveProperty("alice");
  });
});
