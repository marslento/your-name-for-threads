import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { __resetDiagnosticReportsForTests } from "../../src/diagnostics/reportDiagnostic";
import { RecoveryBlockedError } from "../../src/recovery/RecoveryBlockedError";
import { BrowserDirectoryRepository } from "../../src/storage/BrowserDirectoryRepository";
import { BrowserStorageContactsRepository } from "../../src/storage/BrowserStorageContactsRepository";
import { __resetDirectoryAccessQueueForTests, clearOwnerDirectory, mutateOwnerDirectory, readOwnerDirectory, resetOwnerDirectory } from "../../src/storage/directoryAccess";
import { __resetMigrationCoordinatorForTests, loadAndMigrateStorage, loadStorageWithQuarantine } from "../../src/storage/migrations";
import { ROOT, code, filesMatching } from "../fixtures/repoFiles";
import { backgroundSendMessage } from "../fixtures/storage/diagnosticCoordinator";
import { installFakeChrome, type FakeStorageArea } from "../fixtures/storage/fakeChromeStorage";
import { ALICE, ALICE_DIR, AT, BOB, BOB_DIR, DAMAGED_ALICE, directory, twoAccounts, withDirectory } from "../fixtures/storage/recoveryStorage";

/**
 * A damaged Directory must stop its own account and nobody else (Phase 4 Task 17, checklist #12 and the
 * Critical "disables healthy account data because one Directory is corrupt"), and it must still be there,
 * byte for byte, afterwards (design summary section 17). These run the real repositories over a fake
 * storage, because a classifier that says "Bob is fine" is worth nothing if Bob's next save throws, or
 * quietly deletes what belongs to Alice.
 */
const CAROL = "300";
const aliceDamaged = () => withDirectory(ALICE_DIR, DAMAGED_ALICE);

const install = (raw: Record<string, unknown>) => installFakeChrome(raw);

/** Everything durable. The diagnostics buffer is a separate key, written by its own coordinator, and is looked at on its own. */
const durable = (area: FakeStorageArea) => {
  const { diagnostics: _diagnostics, ...rest } = area.snapshot();
  return rest;
};

const directories = (area: FakeStorageArea) => area.snapshot().directories as Record<string, unknown>;

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
  __resetMigrationCoordinatorForTests();
  __resetDirectoryAccessQueueForTests();
  __resetDiagnosticReportsForTests();
});

async function blocked(action: () => Promise<unknown>, scope: "directory" | "global" = "directory"): Promise<RecoveryBlockedError> {
  const error = await action().then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(RecoveryBlockedError);
  expect((error as RecoveryBlockedError).scope).toBe(scope);
  return error as RecoveryBlockedError;
}

describe("Alice's Directory is damaged and Bob's is healthy: loading", () => {
  it("hands out the usable part without Alice's Directory or her binding, and sets hers aside verbatim", async () => {
    install(aliceDamaged());

    const { storage, quarantine } = await loadStorageWithQuarantine();

    expect(Object.keys(storage.directories)).toEqual([BOB_DIR]);
    expect(storage.accountBindings).toEqual({ [BOB]: BOB_DIR });
    expect(storage.settings.enabled).toBe(true);
    expect(quarantine.directories).toEqual({ [ALICE_DIR]: DAMAGED_ALICE });
    expect(quarantine.accountBindings).toEqual({ [ALICE]: ALICE_DIR });
  });

  it("keeps settings and the identity cache working for everyone who has nothing to do with it", async () => {
    const area = install(aliceDamaged());
    const contacts = new BrowserStorageContactsRepository();

    await expect(loadAndMigrateStorage()).resolves.toBeDefined();
    await contacts.cacheIdentityObservation({ username: "stranger", threadsUserId: "7777", source: "network", observedAt: AT });

    await expect(contacts.getCachedIdentity("stranger", AT)).resolves.toMatchObject({ threadsUserId: "7777" });
    expect(directories(area)[ALICE_DIR]).toEqual(DAMAGED_ALICE);
  });

  it("reports the failure as a code in the diagnostics buffer and writes nothing into the payload", async () => {
    const area = installFakeChrome(aliceDamaged(), backgroundSendMessage());
    const before = durable(area);

    await loadAndMigrateStorage();

    await vi.waitFor(() => expect(area.snapshot().diagnostics).toBeDefined());
    expect((area.snapshot().diagnostics as Array<{ code: string }>).map((event) => event.code)).toEqual(["STORAGE_VALIDATION_FAILED"]);
    expect(durable(area)).toEqual(before);
  });
});

describe("Alice's Directory is damaged and Bob's is healthy: Bob", () => {
  it("reads his Directory", async () => {
    install(aliceDamaged());

    const { directory: bobs } = await readOwnerDirectory(BOB);

    expect(bobs?.directoryId).toBe(BOB_DIR);
  });

  it("saves a nickname, and Alice's payload and binding come through exactly as they were", async () => {
    const area = install(aliceDamaged());
    const contacts = new BrowserStorageContactsRepository();

    await contacts.upsertNickname(BOB, { identity: { username: "erin", threadsUserId: "500" }, nickname: "Erin", now: AT });

    const snapshot = area.snapshot();
    expect((snapshot.directories as Record<string, unknown>)[ALICE_DIR]).toEqual(DAMAGED_ALICE);
    expect((snapshot.accountBindings as Record<string, string>)[ALICE]).toBe(ALICE_DIR);
    const bobs = (snapshot.directories as Record<string, { contacts: Record<string, { username: string }> }>)[BOB_DIR];
    expect(Object.values(bobs.contacts).map((c) => c.username).sort()).toEqual(["dave", "erin"]);
    expect(area.writeCount()).toBe(1);
  });

  it("can reset and clear his Directory without touching Alice's", async () => {
    const area = install(aliceDamaged());
    const repository = new BrowserDirectoryRepository();

    await repository.resetDirectoryForOwner(BOB, () => "dir-bob-reset");
    expect(directories(area)[ALICE_DIR]).toEqual(DAMAGED_ALICE);
    expect((area.snapshot().accountBindings as Record<string, string>)[ALICE]).toBe(ALICE_DIR);

    await repository.clearDirectoryForOwner(BOB);
    expect(directories(area)[ALICE_DIR]).toEqual(DAMAGED_ALICE);
    expect(area.snapshot().accountBindings).toEqual({ [ALICE]: ALICE_DIR });
  });

  it("can look up his own Directory by ID, and gets an answer for hers that is not \"there is none\"", async () => {
    install(aliceDamaged());
    const repository = new BrowserDirectoryRepository();

    await expect(repository.getDirectoryById(BOB_DIR)).resolves.toMatchObject({ directoryId: BOB_DIR });
    await blocked(() => repository.getDirectoryById(ALICE_DIR));
  });

  it("cannot adopt Alice's Directory ID, so a backup from her lineage never lands on top of her damaged data", async () => {
    const area = install(aliceDamaged());
    const before = durable(area);

    await blocked(() =>
      mutateOwnerDirectory({
        ownerThreadsUserId: BOB,
        createDirectoryId: () => "unused",
        mutate: (current) => ({ write: true, record: { ...current, directoryId: ALICE_DIR }, result: "adopted" }),
      }),
    );

    expect(area.writeCount()).toBe(0);
    expect(durable(area)).toEqual(before);
  });
});

describe("Alice's Directory is damaged and Bob's is healthy: Alice", () => {
  it("is blocked from reading, and it is a Recovery block that carries no stored text", async () => {
    install(aliceDamaged());

    const error = await blocked(() => readOwnerDirectory(ALICE));

    expect(error.code).toBe("DIRECTORY_INVALID");
    expect(error.message).not.toMatch(/PRIVATE_|dir-alice|not-the-key/);
  });

  it("is blocked from saving, is not silently bound to a new Directory, and nothing is written", async () => {
    const area = install(aliceDamaged());
    const before = durable(area);
    const contacts = new BrowserStorageContactsRepository();

    await blocked(() => contacts.upsertNickname(ALICE, { identity: { username: "erin", threadsUserId: "500" }, nickname: "Erin", now: AT }));

    expect(area.writeCount()).toBe(0);
    expect(durable(area)).toEqual(before);
    expect((area.snapshot().accountBindings as Record<string, string>)[ALICE]).toBe(ALICE_DIR);
  });

  it("is blocked from reset and clear, which would otherwise delete data nobody has been able to look at", async () => {
    const area = install(aliceDamaged());
    const before = durable(area);

    await blocked(() => resetOwnerDirectory(ALICE, () => "fresh"));
    await blocked(() => clearOwnerDirectory(ALICE));

    expect(area.writeCount()).toBe(0);
    expect(durable(area)).toEqual(before);
  });

  it("is blocked whichever of the Directory's records is the damaged one", async () => {
    for (const record of ["junk", null, [], directory("wrong-id"), directory(ALICE_DIR, { tombstones: { t: { contactId: "t", username: "x", createdAt: AT, deletedAt: AT, reason: "merged" } } })]) {
      installFakeChrome(withDirectory(ALICE_DIR, record));
      await blocked(() => readOwnerDirectory(ALICE));
      Reflect.deleteProperty(globalThis, "chrome");
    }
  });
});

describe("Alice's Directory is damaged and Bob's is healthy: an account with no Directory yet", () => {
  it("still gets its first Directory, under a fresh ID, and Alice's payload is untouched", async () => {
    const area = install(aliceDamaged());
    const contacts = new BrowserStorageContactsRepository();

    await contacts.upsertNickname(CAROL, { identity: { username: "erin", threadsUserId: "500" }, nickname: "Erin", now: AT });

    const bindings = area.snapshot().accountBindings as Record<string, string>;
    expect(bindings[CAROL]).toBeDefined();
    expect(bindings[CAROL]).not.toBe(ALICE_DIR);
    expect(bindings[CAROL]).not.toBe(BOB_DIR);
    expect(bindings[ALICE]).toBe(ALICE_DIR);
    expect(directories(area)[ALICE_DIR]).toEqual(DAMAGED_ALICE);
  });
});

describe("a Directory whose contents are malformed is set aside, not read as empty", () => {
  const malformed: Array<[string, Record<string, unknown>]> = [
    ["contacts that are a string", { contacts: "PRIVATE_CONTACTS_PROBE" }],
    ["an index that is an array", { identityIndex: ["PRIVATE_INDEX_PROBE"] }],
    ["a contact with no nickname", { contacts: { c1: { id: "c1", username: "carol", createdAt: AT, updatedAt: AT, identityUpdatedAt: AT, note: "PRIVATE_NOTE_PROBE" } } }],
  ];

  it.each(malformed)("%s: Alice is stopped, Bob carries on, and her payload is exactly as it was", async (_name, patch) => {
    const alices = { ...directory(ALICE_DIR), ...patch };
    const area = install(withDirectory(ALICE_DIR, alices));
    const contacts = new BrowserStorageContactsRepository();

    const { storage, quarantine } = await loadStorageWithQuarantine();
    expect(Object.keys(storage.directories)).toEqual([BOB_DIR]);
    expect(quarantine.directories[ALICE_DIR]).toEqual(alices);

    await contacts.upsertNickname(BOB, { identity: { username: "erin", threadsUserId: "500" }, nickname: "Erin", now: AT });
    expect(directories(area)[ALICE_DIR], "not replaced by an empty collection").toEqual(alices);

    const error = await blocked(() => contacts.upsertNickname(ALICE, { identity: { username: "frank", threadsUserId: "600" }, nickname: "Frank", now: AT }));
    expect(error.message).not.toMatch(/PRIVATE_/);
    expect(directories(area)[ALICE_DIR]).toEqual(alices);
  });
});

describe("the root is damaged: everyone is stopped, and nothing is written", () => {
  it.each([
    ["a setting that is not an object", twoAccounts({ settings: 5 })],
    ["a binding to a Directory that is not there", twoAccounts({ accountBindings: { [ALICE]: "dir-gone", [BOB]: BOB_DIR } })],
    ["a damaged Directory and a damaged setting together", withDirectory(ALICE_DIR, DAMAGED_ALICE, twoAccounts({ settings: 5 }))],
  ])("%s", async (_name, raw) => {
    const area = install(raw);
    const before = durable(area);
    const contacts = new BrowserStorageContactsRepository();

    await expect(loadAndMigrateStorage()).rejects.toThrow();
    await expect(readOwnerDirectory(BOB)).rejects.toThrow();
    await expect(contacts.upsertNickname(BOB, { identity: { username: "erin", threadsUserId: "500" }, nickname: "Erin", now: AT })).rejects.toThrow();

    expect(area.writeCount()).toBe(0);
    expect(durable(area)).toEqual(before);
  });
});

describe("nothing else replaces the directory keys", () => {
  it("only the owner-directory operations and the one-time migration write `directories` or `accountBindings`", () => {
    // `set` replaces a whole key, so a writer that does not put the quarantine back deletes what was set aside.
    // A new one has to be added to this list on purpose, with the quarantine handled.
    const writers = filesMatching(/chrome\.storage\.local\.set\(/).filter((file) => /\b(directories|accountBindings)\b/.test(code(join(ROOT, file))));

    expect(writers).toEqual(["src/storage/directoryAccess.ts", "src/storage/migrations.ts"]);
  });
});
