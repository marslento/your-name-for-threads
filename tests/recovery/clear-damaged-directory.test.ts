import { afterEach, describe, expect, it } from "vitest";

import { RecoveryBlockedError } from "../../src/recovery/RecoveryBlockedError";
import { __resetDirectoryAccessQueueForTests, clearDamagedOwnerDirectory, clearOwnerDirectory } from "../../src/storage/directoryAccess";
import { __resetMigrationCoordinatorForTests } from "../../src/storage/migrations";
import { installFakeChrome } from "../fixtures/storage/fakeChromeStorage";
import { ALICE, ALICE_DIR, BOB, BOB_DIR, DAMAGED_ALICE, twoAccounts, withDirectory } from "../fixtures/storage/recoveryStorage";

/**
 * The one way out that deletes a damaged Directory (Phase 4 Task 19). It exists only for an account that is
 * in Recovery, removes that account's binding and Directory and nothing else, and leaves every other
 * account's data - the damaged ones set aside included - exactly as it found it.
 */
const CAROL = "300";
const aliceDamaged = () => withDirectory(ALICE_DIR, DAMAGED_ALICE);

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
  __resetMigrationCoordinatorForTests();
  __resetDirectoryAccessQueueForTests();
});

describe("clearDamagedOwnerDirectory", () => {
  it("removes the damaged account's Directory and binding, and leaves everything else exactly as it was", async () => {
    const raw = aliceDamaged();
    const area = installFakeChrome(raw);

    await expect(clearDamagedOwnerDirectory(ALICE)).resolves.toEqual({ ok: true });

    const after = area.snapshot();
    expect(Object.keys(after.directories as object)).toEqual([BOB_DIR]);
    expect((after.directories as Record<string, unknown>)[BOB_DIR]).toEqual((raw.directories as Record<string, unknown>)[BOB_DIR]);
    expect(after.accountBindings).toEqual({ [BOB]: BOB_DIR });
    expect(after.settings).toEqual(raw.settings);
    expect(after.identityCache).toEqual(raw.identityCache);
    expect(JSON.stringify(after)).not.toMatch(/PRIVATE_/); // the damaged payload is gone for good
    expect(area.writeCount()).toBe(1);
  });

  it("puts back another account's damaged Directory, and its binding, untouched", async () => {
    const both = withDirectory(BOB_DIR, { directoryId: "not-bob", junk: [1, 2, 3] }, aliceDamaged());
    const area = installFakeChrome(both);

    await expect(clearDamagedOwnerDirectory(ALICE)).resolves.toEqual({ ok: true });

    expect(area.snapshot().directories).toEqual({ [BOB_DIR]: { directoryId: "not-bob", junk: [1, 2, 3] } });
    expect(area.snapshot().accountBindings).toEqual({ [BOB]: BOB_DIR });
  });

  it("leaves the account able to start again with no Directory", async () => {
    const area = installFakeChrome(aliceDamaged());

    await clearDamagedOwnerDirectory(ALICE);

    // Alice now reads as an account with no Directory: an ordinary clear finds nothing for her, and she is not in Recovery.
    await expect(clearOwnerDirectory(ALICE)).resolves.toEqual({ ok: false, reason: "no_directory" });
    expect(area.snapshot().accountBindings).not.toHaveProperty(ALICE);
  });

  it.each([
    ["Bob, whose Directory is healthy", aliceDamaged(), BOB],
    ["an account with no Directory yet", aliceDamaged(), CAROL],
    ["anyone, when nothing is damaged", twoAccounts(), ALICE],
  ])("refuses for %s, and writes nothing", async (_name, raw, owner) => {
    const area = installFakeChrome(raw);
    const before = area.snapshot();

    await expect(clearDamagedOwnerDirectory(owner)).resolves.toEqual({ ok: false, reason: "not_in_recovery" });

    expect(area.writeCount()).toBe(0);
    expect(area.snapshot()).toEqual(before);
  });

  it("refuses when another account is bound to the same damaged Directory, since clearing would take theirs too", async () => {
    const shared = { ...aliceDamaged(), accountBindings: { [ALICE]: ALICE_DIR, [CAROL]: ALICE_DIR, [BOB]: BOB_DIR } };
    const area = installFakeChrome(shared);
    const before = area.snapshot();

    await expect(clearDamagedOwnerDirectory(ALICE)).resolves.toEqual({ ok: false, reason: "shared_directory" });

    expect(area.writeCount()).toBe(0);
    expect(area.snapshot()).toEqual(before);
  });

  it("does not clear anything when the root of storage is damaged: nothing can be scoped", async () => {
    const area = installFakeChrome({ ...aliceDamaged(), settings: 5 });
    const before = area.snapshot();

    await expect(clearDamagedOwnerDirectory(ALICE)).rejects.toThrow();

    expect(area.writeCount()).toBe(0);
    expect(area.snapshot()).toEqual(before);
  });

  it("rejects an owner that is not a Threads user ID, and writes nothing", async () => {
    const area = installFakeChrome(aliceDamaged());

    await expect(clearDamagedOwnerDirectory("alice")).rejects.toThrow("Threads user ID must contain ASCII digits only");

    expect(area.writeCount()).toBe(0);
  });

  it("stops before writing when the proof that authorized it is withdrawn", async () => {
    const area = installFakeChrome(aliceDamaged());
    const controller = new AbortController();
    controller.abort();

    await expect(clearDamagedOwnerDirectory(ALICE, controller.signal)).rejects.toThrow();

    expect(area.writeCount()).toBe(0);
  });

  it("is not what an ordinary clear does: that still refuses a Directory that is in Recovery", async () => {
    const area = installFakeChrome(aliceDamaged());

    await expect(clearOwnerDirectory(ALICE)).rejects.toBeInstanceOf(RecoveryBlockedError);

    expect(area.writeCount()).toBe(0);
  });
});
