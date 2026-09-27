import { afterEach, describe, expect, it, vi } from "vitest";

import { DirectoryFullError, MAX_DIRECTORY_RECORDS, type DirectoryRecord } from "../../src/domain/directory";
import {
  __resetDirectoryAccessQueueForTests,
  clearOwnerDirectory,
  mutateOwnerDirectory,
  readOwnerDirectory,
  resetOwnerDirectory,
} from "../../src/storage/directoryAccess";
import { __resetMigrationCoordinatorForTests } from "../../src/storage/migrations";
import { installFakeChrome } from "../fixtures/storage/fakeChromeStorage";
import { createFakePortRuntime } from "../fixtures/storage/fakePortRuntime";
import { migrationCoordinatorSendMessage } from "../fixtures/storage/migrationCoordinator";

/** A complete contact: the loader checks the fields the type requires, so a stand-in for one has to have them. */
const stub = (id: string) => ({ id, username: id, nickname: id, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", identityUpdatedAt: "2026-01-01T00:00:00.000Z" });

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
  __resetMigrationCoordinatorForTests();
  __resetDirectoryAccessQueueForTests();
});

describe("readOwnerDirectory", () => {
  it("returns undefined for an owner with no binding, without creating anything", async () => {
    const area = installFakeChrome({}, migrationCoordinatorSendMessage());

    const { directory } = await readOwnerDirectory("123");

    expect(directory).toBeUndefined();
    expect(area.snapshot()).toMatchObject({ directories: {}, accountBindings: {} });
  });

  it("rejects a non-numeric ownerThreadsUserId instead of reading against it (Phase 3.5 review round 2, Critical #3)", async () => {
    installFakeChrome({}, migrationCoordinatorSendMessage());

    await expect(readOwnerDirectory("alice")).rejects.toThrow(
      "Threads user ID must contain ASCII digits only",
    );
  });

  it("returns the bound owner's directory", async () => {
    installFakeChrome(
      {
        schemaVersion: 4,
        directories: { "dir-a": { directoryId: "dir-a", contacts: { c1: stub("c1") }, tombstones: {}, identityIndex: {}, identityConflicts: {} } },
        accountBindings: { "123": "dir-a" },
      },
      migrationCoordinatorSendMessage(),
    );

    const { directory } = await readOwnerDirectory("123");

    expect(directory?.directoryId).toBe("dir-a");
    expect(directory?.contacts).toHaveProperty("c1");
  });
});

describe("mutateOwnerDirectory", () => {
  it("rejects a non-numeric ownerThreadsUserId before ever writing a binding (Phase 3.5 review round 2, Critical #3)", async () => {
    const area = installFakeChrome({}, migrationCoordinatorSendMessage());

    await expect(
      mutateOwnerDirectory({
        ownerThreadsUserId: "alice",
        createDirectoryId: () => "dir-new",
        mutate: (current) => ({ write: true, record: { ...current, contacts: { c1: stub("c1") as never } }, result: undefined }),
      }),
    ).rejects.toThrow("Threads user ID must contain ASCII digits only");
    expect(area.writeCount()).toBe(0);
  });

  it("creates a Directory + binding in the same write as the first mutation", async () => {
    const area = installFakeChrome({}, migrationCoordinatorSendMessage());

    const result = await mutateOwnerDirectory({
      ownerThreadsUserId: "123",
      createDirectoryId: () => "dir-new",
      mutate: (current) => ({
        write: true,
        record: { ...current, contacts: { c1: stub("c1") as never } },
        result: "created",
      }),
    });

    expect(result).toBe("created");
    const snapshot = area.snapshot() as { directories: Record<string, unknown>; accountBindings: Record<string, string> };
    expect(snapshot.accountBindings).toEqual({ "123": "dir-new" });
    expect(snapshot.directories["dir-new"]).toMatchObject({ directoryId: "dir-new", contacts: { c1: stub("c1") } });
  });

  it("performs no write at all when mutate opts out (failed/no-op mutation leaves no dangling binding), while still returning a real result", async () => {
    const area = installFakeChrome({}, migrationCoordinatorSendMessage());

    const result = await mutateOwnerDirectory({
      ownerThreadsUserId: "123",
      createDirectoryId: () => "dir-new",
      mutate: () => ({ write: false, result: "no-op" }),
    });

    expect(result).toBe("no-op");
    expect(area.writeCount()).toBe(1); // only the migration's own write, no mutation write
    expect(area.snapshot()).toMatchObject({ directories: {}, accountBindings: {} });
  });

  it("propagates a synchronous throw from mutate with no write (e.g. a real conflict)", async () => {
    const area = installFakeChrome({}, migrationCoordinatorSendMessage());

    await expect(
      mutateOwnerDirectory({
        ownerThreadsUserId: "123",
        createDirectoryId: () => "dir-new",
        mutate: () => {
          throw new Error("conflict");
        },
      }),
    ).rejects.toThrow("conflict");

    expect(area.snapshot()).toMatchObject({ directories: {}, accountBindings: {} });
  });

  it("mutates an already-bound owner's directory without minting a new id or touching the binding", async () => {
    installFakeChrome(
      {
        schemaVersion: 4,
        directories: { "dir-a": { directoryId: "dir-a", contacts: {}, tombstones: {}, identityIndex: {}, identityConflicts: {} } },
        accountBindings: { "123": "dir-a" },
      },
      migrationCoordinatorSendMessage(),
    );

    await mutateOwnerDirectory({
      ownerThreadsUserId: "123",
      createDirectoryId: () => {
        throw new Error("must not mint a new id for an already-bound owner");
      },
      mutate: (current) => ({
        write: true,
        record: { ...current, contacts: { c1: stub("c1") as never } },
        result: undefined,
      }),
    });

    const { directory } = await readOwnerDirectory("123");
    expect(directory?.directoryId).toBe("dir-a");
    expect(directory?.contacts).toHaveProperty("c1");
  });

  it("serializes two different owners' concurrent first mutations without either clobbering the other (Phase 3.5 review, Medium #7)", async () => {
    const area = installFakeChrome({}, migrationCoordinatorSendMessage());

    await Promise.all([
      mutateOwnerDirectory({
        ownerThreadsUserId: "123",
        createDirectoryId: () => "dir-alice",
        mutate: (current) => ({ write: true, record: { ...current, contacts: { alice: stub("alice") as never } }, result: undefined }),
      }),
      mutateOwnerDirectory({
        ownerThreadsUserId: "456",
        createDirectoryId: () => "dir-bob",
        mutate: (current) => ({ write: true, record: { ...current, contacts: { bob: stub("bob") as never } }, result: undefined }),
      }),
    ]);

    const snapshot = area.snapshot() as {
      directories: Record<string, { contacts: Record<string, unknown> }>;
      accountBindings: Record<string, string>;
    };
    expect(snapshot.accountBindings).toEqual({ "123": "dir-alice", "456": "dir-bob" });
    expect(snapshot.directories["dir-alice"].contacts).toHaveProperty("alice");
    expect(snapshot.directories["dir-bob"].contacts).toHaveProperty("bob");
  });

  it("serializes two concurrent mutations to the SAME owner's directory - the second sees the first's write", async () => {
    installFakeChrome({}, migrationCoordinatorSendMessage());

    await Promise.all([
      mutateOwnerDirectory({
        ownerThreadsUserId: "123",
        createDirectoryId: () => "dir-a",
        mutate: (current) => ({ write: true, record: { ...current, contacts: { ...current.contacts, c1: stub("c1") as never } }, result: undefined }),
      }),
      mutateOwnerDirectory({
        ownerThreadsUserId: "123",
        createDirectoryId: () => "dir-a",
        mutate: (current) => ({ write: true, record: { ...current, contacts: { ...current.contacts, c2: stub("c2") as never } }, result: undefined }),
      }),
    ]);

    const { directory } = await readOwnerDirectory("123");
    expect(directory?.contacts).toHaveProperty("c1");
    expect(directory?.contacts).toHaveProperty("c2");
  });

  it("rebinds the owner to a different directoryId when mutate adopts a new lineage, without deleting the old (possibly shared) entry", async () => {
    const area = installFakeChrome(
      {
        schemaVersion: 4,
        directories: {
          "dir-old": { directoryId: "dir-old", contacts: {}, tombstones: {}, identityIndex: {}, identityConflicts: {} },
        },
        accountBindings: { "123": "dir-old" },
      },
      migrationCoordinatorSendMessage(),
    );

    await mutateOwnerDirectory({
      ownerThreadsUserId: "123",
      createDirectoryId: () => {
        throw new Error("must not mint a fresh id when adopting an explicit lineage");
      },
      mutate: () => ({
        write: true,
        record: { directoryId: "dir-restored", contacts: { c1: stub("c1") as never }, tombstones: {}, identityIndex: {}, identityConflicts: {} },
        result: undefined,
      }),
    });

    const snapshot = area.snapshot() as {
      directories: Record<string, { contacts: Record<string, unknown> }>;
      accountBindings: Record<string, string>;
    };
    expect(snapshot.accountBindings).toEqual({ "123": "dir-restored" });
    expect(snapshot.directories["dir-restored"].contacts).toHaveProperty("c1");
    expect(snapshot.directories).toHaveProperty("dir-old"); // left alone - Reset's own guarded deletion owns cleanup
  });

  describe("deleteAbandonedDirectoryIfUnshared (Phase 3.5 Task 36)", () => {
    it("deletes the abandoned directoryId in the same write when nothing else is bound to it", async () => {
      const area = installFakeChrome(
        {
          schemaVersion: 4,
          directories: {
            "dir-b": { directoryId: "dir-b", contacts: {}, tombstones: {}, identityIndex: {}, identityConflicts: {} },
          },
          accountBindings: { "123": "dir-b" },
        },
        migrationCoordinatorSendMessage(),
      );

      await mutateOwnerDirectory({
        ownerThreadsUserId: "123",
        createDirectoryId: () => {
          throw new Error("must not mint a fresh id when adopting an explicit lineage");
        },
        deleteAbandonedDirectoryIfUnshared: true,
        mutate: () => ({
          write: true,
          record: { directoryId: "dir-a", contacts: { c1: stub("c1") as never }, tombstones: {}, identityIndex: {}, identityConflicts: {} },
          result: undefined,
        }),
      });

      const snapshot = area.snapshot() as {
        directories: Record<string, unknown>;
        accountBindings: Record<string, string>;
      };
      expect(snapshot.accountBindings).toEqual({ "123": "dir-a" });
      expect(snapshot.directories).toHaveProperty("dir-a");
      expect(snapshot.directories).not.toHaveProperty("dir-b");
    });

    // Nothing can reach the "abandoning a still-shared directoryId" branch
    // any more: storage two accounts share is refused at the load boundary
    // (Phase 3.6 §3, review round 7 Medium #3) - see the single-binding
    // suite at the bottom of this file.

    it("is a no-op when the mutation does not switch lineage at all", async () => {
      const area = installFakeChrome(
        {
          schemaVersion: 4,
          directories: {
            "dir-a": { directoryId: "dir-a", contacts: {}, tombstones: {}, identityIndex: {}, identityConflicts: {} },
          },
          accountBindings: { "123": "dir-a" },
        },
        migrationCoordinatorSendMessage(),
      );

      await mutateOwnerDirectory({
        ownerThreadsUserId: "123",
        createDirectoryId: () => "unused",
        deleteAbandonedDirectoryIfUnshared: true,
        mutate: (current) => ({
          write: true,
          record: { ...current, contacts: { c1: stub("c1") as never } },
          result: undefined,
        }),
      });

      const snapshot = area.snapshot() as { directories: Record<string, unknown> };
      expect(snapshot.directories).toHaveProperty("dir-a");
    });
  });
});

describe("mutateOwnerDirectory: the Directory limit (owner's decision after Codex Security scan 0905)", () => {
  const AT = "2026-01-01T00:00:00.000Z";
  /** One contact, `c1`, and deleted records for the rest: they count as much as contacts do. */
  const storageOf = (records: number) => ({
    schemaVersion: 4,
    directories: {
      "dir-a": {
        directoryId: "dir-a",
        contacts: { c1: stub("c1") },
        tombstones: Object.fromEntries(Array.from({ length: records - 1 }, (_, i) => [`t${i}`, { contactId: `t${i}`, username: `gone${i}`, createdAt: AT, deletedAt: AT, reason: "user_deleted" }])),
        identityIndex: {},
        identityConflicts: {},
      },
    },
    accountBindings: { "123": "dir-a" },
  });
  const write = (change: (current: DirectoryRecord) => Partial<DirectoryRecord>) =>
    mutateOwnerDirectory({
      ownerThreadsUserId: "123",
      createDirectoryId: () => "unused",
      mutate: (current) => ({ write: true, record: { ...current, ...change(current) }, result: undefined }),
    });
  const addContact = (current: DirectoryRecord) => ({ contacts: { ...current.contacts, c2: stub("c2") as never } });

  it("refuses a write that would take it past the limit, and writes nothing", async () => {
    const area = installFakeChrome(storageOf(MAX_DIRECTORY_RECORDS), migrationCoordinatorSendMessage());
    const before = area.snapshot();

    await expect(write(addContact)).rejects.toBeInstanceOf(DirectoryFullError);
    expect(area.snapshot()).toEqual(before);
  });

  it("(control) takes the write that brings it up to the limit", async () => {
    const area = installFakeChrome(storageOf(MAX_DIRECTORY_RECORDS - 1), migrationCoordinatorSendMessage());

    await write(addContact);

    expect((area.snapshot() as never as { directories: Record<string, DirectoryRecord> }).directories["dir-a"].contacts).toHaveProperty("c2");
  });

  it("still lets a Directory already past the limit be edited and emptied", async () => {
    const area = installFakeChrome(storageOf(MAX_DIRECTORY_RECORDS + 5), migrationCoordinatorSendMessage());
    const saved = () => (area.snapshot() as never as { directories: Record<string, DirectoryRecord> }).directories["dir-a"];

    await write((current) => ({ contacts: { c1: { ...current.contacts.c1, nickname: "edited" } } }));
    expect(saved().contacts.c1.nickname).toBe("edited");

    await write(() => ({ contacts: {}, tombstones: {} }));
    expect(saved().contacts).toEqual({});
  });
});

describe("resetOwnerDirectory (Phase 3.5 Task 28)", () => {
  it("rebinds to a brand-new empty Directory and deletes the old one, in one write", async () => {
    const area = installFakeChrome(
      {
        schemaVersion: 4,
        directories: {
          "dir-old": {
            directoryId: "dir-old",
            contacts: { c1: { ...stub("c1"), threadsUserId: "1" } as never },
            tombstones: { t1: { contactId: "t1" } as never },
            identityIndex: { "threads:1": "c1" },
            identityConflicts: {},
          },
        },
        accountBindings: { "123": "dir-old" },
      },
      migrationCoordinatorSendMessage(),
    );

    const result = await resetOwnerDirectory("123", () => "dir-new");

    expect(result).toMatchObject({ ok: true, newDirectory: { directoryId: "dir-new", contacts: {}, tombstones: {} } });
    const snapshot = area.snapshot() as {
      directories: Record<string, unknown>;
      accountBindings: Record<string, string>;
    };
    expect(snapshot.accountBindings).toEqual({ "123": "dir-new" });
    expect(snapshot.directories).toHaveProperty("dir-new");
    expect(snapshot.directories).not.toHaveProperty("dir-old");
  });

  it("refuses with no_directory for an owner who has never had one, without writing anything", async () => {
    const area = installFakeChrome({}, migrationCoordinatorSendMessage());

    const result = await resetOwnerDirectory("123", () => "dir-new");

    expect(result).toEqual({ ok: false, reason: "no_directory" });
    expect(area.snapshot()).toMatchObject({ directories: {}, accountBindings: {} });
  });

  it("refuses to act on storage two accounts share, rather than destroying the other owner's directory", async () => {
    const area = installFakeChrome(
      {
        schemaVersion: 4,
        directories: {
          "dir-shared": { directoryId: "dir-shared", contacts: {}, tombstones: {}, identityIndex: {}, identityConflicts: {} },
        },
        accountBindings: { "123": "dir-shared", "456": "dir-shared" },
      },
      migrationCoordinatorSendMessage(),
    );
    const before = area.writeCount();

    // Refused at the load boundary now (review round 7, Medium #3) rather
    // than by resetDirectory's own shared_directory branch, which stays as
    // the domain-level half of the same invariant.
    await expect(resetOwnerDirectory("123", () => "dir-new")).rejects.toThrow(/bound to both/);

    expect(area.writeCount()).toBe(before);
    const snapshot = area.snapshot() as { accountBindings: Record<string, string> };
    expect(snapshot.accountBindings).toEqual({ "123": "dir-shared", "456": "dir-shared" });
  });

  it("rejects a non-numeric ownerThreadsUserId before ever reading or writing", async () => {
    installFakeChrome({}, migrationCoordinatorSendMessage());

    await expect(resetOwnerDirectory("alice", () => "dir-new")).rejects.toThrow(
      "Threads user ID must contain ASCII digits only",
    );
  });
});

/**
 * `directoryAccess.ts`'s own `enqueue` only serializes calls made through
 * ONE instance of the module, exactly like a content script tab and the
 * Dashboard each get their own separate instance in the real extension -
 * every test above shares a single top-level import, so it can never
 * actually exercise the cross-context lock (Phase 3.5 review round 3, High
 * #4). These tests get two genuinely independent instances via
 * `vi.resetModules()` + dynamic `import()` between them, both pointed at
 * the SAME fake `chrome.storage.local` and the SAME fake
 * `chrome.runtime.connect`/`onConnect` pair - the real cross-context
 * situation `withDirectoryLock` exists for.
 */
describe("true cross-context regressions via separate module instances (Phase 3.5 review round 3, High #4)", () => {
  function installCrossContextChrome(initial: Record<string, unknown> = {}) {
    const area = installFakeChrome(initial, migrationCoordinatorSendMessage());
    const portRuntime = createFakePortRuntime();
    Object.assign((globalThis as unknown as { chrome: { runtime: object } }).chrome.runtime, portRuntime);
    return area;
  }

  async function twoFreshDirectoryAccessContexts() {
    const { installDirectoryLockArbiter } = await import("../../src/storage/directoryLock");
    installDirectoryLockArbiter();

    vi.resetModules();
    const contextA = await import("../../src/storage/directoryAccess");
    vi.resetModules();
    const contextB = await import("../../src/storage/directoryAccess");
    return [contextA, contextB] as const;
  }

  it("two different owners' concurrent lazy-create from separate contexts both land - neither is dropped", async () => {
    const area = installCrossContextChrome();
    const [contentScriptContext, dashboardContext] = await twoFreshDirectoryAccessContexts();

    await Promise.all([
      contentScriptContext.mutateOwnerDirectory({
        ownerThreadsUserId: "123",
        createDirectoryId: () => "dir-alice",
        mutate: (current) => ({
          write: true,
          record: { ...current, contacts: { alice: stub("alice") as never } },
          result: undefined,
        }),
      }),
      dashboardContext.mutateOwnerDirectory({
        ownerThreadsUserId: "456",
        createDirectoryId: () => "dir-bob",
        mutate: (current) => ({
          write: true,
          record: { ...current, contacts: { bob: stub("bob") as never } },
          result: undefined,
        }),
      }),
    ]);

    const snapshot = area.snapshot() as {
      directories: Record<string, { contacts: Record<string, unknown> }>;
      accountBindings: Record<string, string>;
    };
    expect(snapshot.accountBindings).toEqual({ "123": "dir-alice", "456": "dir-bob" });
    expect(snapshot.directories["dir-alice"].contacts).toHaveProperty("alice");
    expect(snapshot.directories["dir-bob"].contacts).toHaveProperty("bob");
  });

  it("two concurrent updates to the SAME owner's Directory from separate contexts both land - neither is dropped", async () => {
    const area = installCrossContextChrome({
      schemaVersion: 4,
      directories: { "dir-a": { directoryId: "dir-a", contacts: {}, tombstones: {}, identityIndex: {}, identityConflicts: {} } },
      accountBindings: { "123": "dir-a" },
    });
    const [contentScriptContext, dashboardContext] = await twoFreshDirectoryAccessContexts();

    await Promise.all([
      contentScriptContext.mutateOwnerDirectory({
        ownerThreadsUserId: "123",
        createDirectoryId: () => {
          throw new Error("already bound");
        },
        mutate: (current) => ({
          write: true,
          record: { ...current, contacts: { ...current.contacts, c1: stub("c1") as never } },
          result: undefined,
        }),
      }),
      dashboardContext.mutateOwnerDirectory({
        ownerThreadsUserId: "123",
        createDirectoryId: () => {
          throw new Error("already bound");
        },
        mutate: (current) => ({
          write: true,
          record: { ...current, contacts: { ...current.contacts, c2: stub("c2") as never } },
          result: undefined,
        }),
      }),
    ]);

    const snapshot = area.snapshot() as { directories: Record<string, { contacts: Record<string, unknown> }> };
    expect(snapshot.directories["dir-a"].contacts).toHaveProperty("c1");
    expect(snapshot.directories["dir-a"].contacts).toHaveProperty("c2");
  });

  it("refuses a Reset and a rebind from two contexts alike when storage already shares one Directory, leaving it untouched", async () => {
    const area = installCrossContextChrome({
      schemaVersion: 4,
      directories: {
        "dir-shared": {
          directoryId: "dir-shared",
          contacts: { c1: stub("c1") as never },
          tombstones: {},
          identityIndex: {},
          identityConflicts: {},
        },
      },
      accountBindings: { "123": "dir-shared", "456": "dir-shared" },
    });
    const [contentScriptContext, dashboardContext] = await twoFreshDirectoryAccessContexts();
    const before = area.writeCount();

    // There is no interleaving left to get right: neither context can load
    // this storage at all, so the shared Directory survives both (Phase 3.6
    // §3, review round 7 Medium #3) instead of one of them deleting it out
    // from under the other.
    const outcomes = await Promise.allSettled([
      contentScriptContext.resetOwnerDirectory("123", () => "dir-123-new"),
      dashboardContext.mutateOwnerDirectory({
        ownerThreadsUserId: "456",
        createDirectoryId: () => {
          throw new Error("already bound");
        },
        mutate: () => ({
          write: true,
          record: { directoryId: "dir-456-new", contacts: {}, tombstones: {}, identityIndex: {}, identityConflicts: {} },
          result: undefined,
        }),
      }),
    ]);

    expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
    expect(area.writeCount()).toBe(before);
    const snapshot = area.snapshot() as { directories: Record<string, unknown>; accountBindings: Record<string, string> };
    expect(snapshot.accountBindings).toEqual({ "123": "dir-shared", "456": "dir-shared" });
    expect(snapshot.directories).toHaveProperty("dir-shared");
  });
});

function twoAccountStorage() {
  return {
    schemaVersion: 4 as const,
    directories: {
      "dir-a": { directoryId: "dir-a", contacts: { c1: stub("c1") }, tombstones: {}, identityIndex: {}, identityConflicts: {} },
      "dir-b": { directoryId: "dir-b", contacts: { c2: stub("c2") }, tombstones: {}, identityIndex: {}, identityConflicts: {} },
    },
    accountBindings: { "123": "dir-a", "456": "dir-b" },
    identityCache: { "123": { threadsUserId: "123", username: "alice", observedAt: "2026-01-01T00:00:00.000Z" } },
    settings: { enabled: true, nicknameDisplay: { profile: true, feed: true, replies: true, quotes: true } },
  };
}

describe("clearOwnerDirectory (Phase \u00a725/\u00a726)", () => {
  it("removes only this account's binding and Directory", async () => {
    const area = installFakeChrome(twoAccountStorage() as never, migrationCoordinatorSendMessage());

    const result = await clearOwnerDirectory("123");

    expect(result.ok).toBe(true);
    const snapshot = area.snapshot() as never as { directories: Record<string, unknown>; accountBindings: Record<string, string> };
    expect(Object.keys(snapshot.directories)).toEqual(["dir-b"]);
    expect(snapshot.accountBindings).toEqual({ "456": "dir-b" });
  });

  it("leaves the browser-global settings and identityCache keys alone", async () => {
    const area = installFakeChrome(twoAccountStorage() as never, migrationCoordinatorSendMessage());

    await clearOwnerDirectory("123");

    const snapshot = area.snapshot() as never as { identityCache: Record<string, unknown>; settings: { enabled: boolean } };
    expect(Object.keys(snapshot.identityCache)).toEqual(["123"]);
    expect(snapshot.settings.enabled).toBe(true);
  });

  it("reports no_directory and writes nothing for an account that never had one", async () => {
    const area = installFakeChrome({}, migrationCoordinatorSendMessage());

    const result = await clearOwnerDirectory("123");

    expect(result).toEqual({ ok: false, reason: "no_directory" });
    expect(area.snapshot()).toMatchObject({ directories: {}, accountBindings: {} });
  });

  it("rejects a non-numeric ownerThreadsUserId instead of clearing against it", async () => {
    installFakeChrome(twoAccountStorage() as never, migrationCoordinatorSendMessage());

    await expect(clearOwnerDirectory("alice")).rejects.toThrow("Threads user ID must contain ASCII digits only");
  });
});

describe("v1.0 single-binding invariant (Phase 3.6 \u00a73)", () => {
  it("refuses to bind an account to a directoryId another account already holds", async () => {
    const area = installFakeChrome(twoAccountStorage() as never, migrationCoordinatorSendMessage());
    const before = area.snapshot();

    await expect(
      mutateOwnerDirectory({
        ownerThreadsUserId: "123",
        createDirectoryId: () => "unused",
        // A Restore adopting the OTHER account's lineage - the only shape of
        // mutation that could ever produce a shared binding.
        mutate: () => ({
          write: true,
          record: { directoryId: "dir-b", contacts: {}, tombstones: {}, identityIndex: {}, identityConflicts: {} },
          result: null,
        }),
      }),
    ).rejects.toThrow(/already bound/);

    expect(area.snapshot()).toEqual(before);
  });

  /**
   * Blocking only the mutation that *creates* a shared binding is half an
   * invariant (review round 7, Medium #3): storage that already contains one
   * would otherwise be read and written in place by both accounts, and one
   * account's ordinary edit would silently rewrite the other's contacts.
   */
  it("refuses to read storage where one Directory is bound to two accounts, leaving it untouched", async () => {
    const area = installFakeChrome(
      {
        schemaVersion: 4,
        directories: {
          "dir-1": { directoryId: "dir-1", contacts: {}, tombstones: {}, identityIndex: {}, identityConflicts: {} },
        },
        accountBindings: { "123": "dir-1", "456": "dir-1" },
      },
      migrationCoordinatorSendMessage(),
    );
    const before = area.writeCount();

    await expect(readOwnerDirectory("123")).rejects.toThrow(/bound to both/);

    expect(area.writeCount()).toBe(before);
    expect((area.snapshot() as { accountBindings: Record<string, string> }).accountBindings).toEqual({
      "123": "dir-1",
      "456": "dir-1",
    });
  });

  it("still allows an account to adopt a lineage nothing else is bound to", async () => {
    const area = installFakeChrome(twoAccountStorage() as never, migrationCoordinatorSendMessage());

    await mutateOwnerDirectory({
      ownerThreadsUserId: "123",
      createDirectoryId: () => "unused",
      mutate: () => ({
        write: true,
        record: { directoryId: "dir-old", contacts: {}, tombstones: {}, identityIndex: {}, identityConflicts: {} },
        result: null,
      }),
    });

    const snapshot = area.snapshot() as never as { accountBindings: Record<string, string> };
    expect(snapshot.accountBindings).toEqual({ "123": "dir-old", "456": "dir-b" });
  });
});
