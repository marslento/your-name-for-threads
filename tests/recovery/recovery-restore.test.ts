import { afterEach, describe, expect, it, vi } from "vitest";

import { parseRecoveryText, type RecoverySource } from "../../src/recovery/recoveryImport";
import { commitRecoveryRestore, previewRecoveryRestore } from "../../src/recovery/recoveryRestore";
import type { RecoveryPreview } from "../../src/recovery/recoveryTarget";
import { validateStorageHealth } from "../../src/recovery/validateStorageHealth";
import { BrowserStorageContactsRepository } from "../../src/storage/BrowserStorageContactsRepository";
import { __resetDirectoryAccessQueueForTests, clearDamagedOwnerDirectory } from "../../src/storage/directoryAccess";
import { installDirectoryLockArbiter, withDirectoryLock } from "../../src/storage/directoryLock";
import { __resetMigrationCoordinatorForTests } from "../../src/storage/migrations";
import { installFakeChrome, type FakeStorageArea } from "../fixtures/storage/fakeChromeStorage";
import { createFakePortRuntime } from "../fixtures/storage/fakePortRuntime";
import { recoveryDirectory, recoveryImportFixture } from "../fixtures/storage/recoveryImport";
import { ALICE, ALICE_DIR, BOB, BOB_DIR, contact, twoAccounts, withDirectory } from "../fixtures/storage/recoveryStorage";

/**
 * The restore itself (Recovery Restore 1.1.0, spec T3-T7; A4, A11-A14), over one fake `chrome.storage.local` and the
 * real Directory lock arbiter on a fake port runtime - never a lock-free mock. Every refusal checks the whole snapshot
 * and the write count.
 */
const LATER = "2026-09-26T00:00:00.000Z";
type Dump = ReturnType<typeof recoveryImportFixture>;

const sourceOf = (dump: Dump = recoveryImportFixture()): RecoverySource => {
  const result = parseRecoveryText(JSON.stringify(dump), ALICE);
  if (!result.ok) throw new Error(result.code);
  return result.value;
};
/** Alice's stored Directory exactly as the file holds it: damaged, so she is in Recovery. */
const inRecovery = (dump: Dump = recoveryImportFixture()) => withDirectory(ALICE_DIR, structuredClone(dump.storage.directories[ALICE_DIR]));
const withoutAlice = () => {
  const raw = twoAccounts();
  return { ...raw, directories: { [BOB_DIR]: (raw.directories as Record<string, unknown>)[BOB_DIR] }, accountBindings: { [BOB]: BOB_DIR } };
};

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

interface Installed {
  area: FakeStorageArea;
  runtime: ReturnType<typeof createFakePortRuntime>;
  clear: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.spyOn>;
}

/** The fake storage plus the real lock arbiter. `clear` exists only to prove nothing calls it. */
function install(raw: Record<string, unknown>, { lock = true } = {}): Installed {
  const area = installFakeChrome(raw);
  const runtime = createFakePortRuntime();
  if (lock) {
    Object.assign(chrome, { runtime });
    installDirectoryLockArbiter();
  }
  const clear = vi.fn();
  Object.assign(area, { clear });
  const remove = vi.spyOn(area, "remove");
  return { area, runtime, clear, remove };
}

async function previewOf(source = sourceOf(), signal = new AbortController().signal): Promise<RecoveryPreview> {
  const result = await previewRecoveryRestore({ source, now: LATER, signal });
  if (!result.ok) throw new Error(`expected a preview, got ${result.code}`);
  return result.value;
}

function expectUntouched(installed: Installed, before: Record<string, unknown>, writes = 0) {
  expect(installed.area.snapshot()).toEqual(before);
  expect(installed.area.writeCount()).toBe(writes);
  expect(installed.clear).not.toHaveBeenCalled();
  expect(installed.remove).not.toHaveBeenCalled();
}

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, "chrome");
  __resetDirectoryAccessQueueForTests();
  __resetMigrationCoordinatorForTests();
});

describe("previewRecoveryRestore: reading only", () => {
  it("analyzes without writing anything", async () => {
    const installed = install(inRecovery());
    const before = installed.area.snapshot();

    const preview = await previewOf();

    expect(preview.target.operation).toBe("rebuild_damaged");
    expect(preview.candidate.summary).toMatchObject({ contacts: 1, tombstones: 1, identityMismatchCount: 1 });
    expectUntouched(installed, before);
  });

  it("never starts a storage migration: older storage is refused as it is", async () => {
    const legacy = { schemaVersion: 2, contacts: {}, tombstones: {}, identityIndex: {}, identityCache: {}, identityConflicts: {}, settings: {} };
    const sendMessage = vi.fn(async () => ({ ok: true }));
    const area = installFakeChrome(legacy, sendMessage);

    await expect(previewRecoveryRestore({ source: sourceOf(), now: LATER, signal: new AbortController().signal })).resolves.toEqual({ ok: false, code: "unsupported_storage" });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(area.writeCount()).toBe(0);
    expect(area.snapshot()).toEqual(legacy);
  });

  it("keeps its own copy of the file's records", async () => {
    install(inRecovery());
    const source = sourceOf();

    const preview = await previewOf(source);
    source.contacts.c1.note = "changed by the caller later";

    expect(preview.source.contacts.c1.note).toBe("Keep note");
    expect(preview.candidate.record.contacts.c1.note).toBe("Keep note");
  });

  it("does not refuse a file for derived data too deep to copy: that data is rebuilt", async () => {
    install(inRecovery());
    let deep: unknown = [];
    for (let i = 0; i < 200_000; i += 1) deep = [deep];
    expect(() => structuredClone(deep)).toThrow();
    const source = { ...sourceOf(), originalDerived: { identityIndex: deep, identityConflicts: {} } };

    const result = await previewRecoveryRestore({ source, now: LATER, signal: new AbortController().signal });

    expect(result).toMatchObject({ ok: true, value: { candidate: { summary: { originalIndexEntries: null } } } });
  });

  it("does not read at all once the authority is gone", async () => {
    const installed = install(inRecovery());
    const get = vi.spyOn(installed.area, "get");
    const controller = new AbortController();
    controller.abort();

    await expect(previewRecoveryRestore({ source: sourceOf(), now: LATER, signal: controller.signal })).resolves.toEqual({ ok: false, code: "authority_revoked" });
    expect(get).not.toHaveBeenCalled();
  });

  it("produces no late preview when the authority goes while storage is being read (A12)", async () => {
    const installed = install(inRecovery());
    const original = installed.area.get.bind(installed.area);
    const gate = deferred();
    const reading = deferred();
    vi.spyOn(installed.area, "get").mockImplementationOnce(async (keys) => {
      const snapshot = await original(keys);
      reading.resolve();
      await gate.promise;
      return snapshot;
    });
    const controller = new AbortController();

    const pending = previewRecoveryRestore({ source: sourceOf(), now: LATER, signal: controller.signal });
    await reading.promise;
    controller.abort();
    gate.resolve();

    await expect(pending).resolves.toEqual({ ok: false, code: "authority_revoked" });
  });

  it("reports a storage read that fails as such, not as a Recovery state", async () => {
    const installed = install(inRecovery());
    vi.spyOn(installed.area, "get").mockRejectedValueOnce(new Error("PRIVATE_READ_PROBE"));

    await expect(previewRecoveryRestore({ source: sourceOf(), now: LATER, signal: new AbortController().signal })).resolves.toEqual({ ok: false, code: "storage_read_failed" });
  });
});

describe("commitRecoveryRestore: one set, under the lock", () => {
  it("rebuilds the damaged Directory without clearing it first, and changes nothing else (A4, T5)", async () => {
    const installed = install(inRecovery());
    const before = installed.area.snapshot();
    const set = vi.spyOn(installed.area, "set");
    const preview = await previewOf();

    const result = await commitRecoveryRestore(preview);

    expect(result).toEqual({ ok: true, value: { status: "restored", summary: preview.candidate.summary } });
    expect(installed.area.writeCount()).toBe(1);
    expect(set).toHaveBeenCalledTimes(1);
    expect(Object.keys(set.mock.calls[0][0] as object)).toEqual(["directories", "accountBindings"]);
    const after = installed.area.snapshot() as Record<string, Record<string, unknown>>;
    expect(validateStorageHealth(after)).toEqual({ kind: "healthy" });
    expect(after.directories[ALICE_DIR]).toEqual(preview.candidate.record);
    expect((after.directories[ALICE_DIR] as { contacts: unknown }).contacts).toEqual(recoveryDirectory(recoveryImportFixture()).contacts);
    expect((after.directories[ALICE_DIR] as { tombstones: unknown }).tombstones).toEqual(recoveryDirectory(recoveryImportFixture()).tombstones);
    expect(after.directories[BOB_DIR]).toEqual((before.directories as Record<string, unknown>)[BOB_DIR]);
    expect(after.accountBindings).toEqual(before.accountBindings);
    expect(after.settings).toEqual(before.settings);
    expect(after.identityCache).toEqual(before.identityCache);
    expect(installed.clear).not.toHaveBeenCalled();
    expect(installed.remove).not.toHaveBeenCalled();
  });

  it("restores into an account that was cleared, binding it in the same write (A3)", async () => {
    const installed = install(withoutAlice());
    const preview = await previewOf();

    await expect(commitRecoveryRestore(preview)).resolves.toMatchObject({ ok: true, value: { status: "restored" } });

    const after = installed.area.snapshot() as Record<string, Record<string, unknown>>;
    expect(after.accountBindings).toEqual({ [BOB]: BOB_DIR, [ALICE]: ALICE_DIR });
    expect(after.directories[ALICE_DIR]).toEqual(preview.candidate.record);
    expect(installed.area.writeCount()).toBe(1);
  });

  it("never runs without the lock (T4)", async () => {
    const installed = install(inRecovery(), { lock: false });
    const before = installed.area.snapshot();
    const preview = await previewOf();

    await expect(commitRecoveryRestore(preview)).resolves.toEqual({ ok: false, code: "lock_unavailable" });
    expectUntouched(installed, before);
  });

  it("refuses when the lock's port closes before it is granted (T4, A12)", async () => {
    const installed = install(inRecovery(), { lock: false });
    const runtime = createFakePortRuntime();
    Object.assign(chrome, { runtime });
    runtime.onConnect.addListener((port) => port.disconnect());
    const before = installed.area.snapshot();
    const preview = await previewOf();

    await expect(commitRecoveryRestore(preview)).resolves.toEqual({ ok: false, code: "lock_unavailable" });
    expectUntouched(installed, before);
  });

  it("does not commit when the authority goes while it waits for the lock (A12)", async () => {
    const installed = install(inRecovery());
    const controller = new AbortController();
    const preview = await previewOf(sourceOf(), controller.signal);
    const before = installed.area.snapshot();
    const held = deferred();
    const release = deferred();
    const holder = withDirectoryLock(async () => {
      held.resolve();
      await release.promise;
    });
    await held.promise;
    const waiting = deferred();
    const connect = installed.runtime.connect.bind(installed.runtime);
    vi.spyOn(installed.runtime, "connect").mockImplementation((info) => {
      const port = connect(info);
      waiting.resolve();
      return port;
    });

    const get = vi.spyOn(installed.area, "get");

    const pending = commitRecoveryRestore(preview);
    await waiting.promise;
    controller.abort();
    release.resolve();
    await holder;

    await expect(pending).resolves.toEqual({ ok: false, code: "authority_revoked" });
    expect(get, "refused as soon as the lock was granted, before reading").not.toHaveBeenCalled();
    expectUntouched(installed, before);
    // Nothing was left holding the lock.
    await expect(withDirectoryLock(async () => "free", { required: true })).resolves.toBe("free");
  });

  it("does not commit when the authority goes while storage is read under the lock, and a new confirmation does not revive it (A12)", async () => {
    const installed = install(inRecovery());
    const controller = new AbortController();
    const preview = await previewOf(sourceOf(), controller.signal);
    const before = installed.area.snapshot();
    const original = installed.area.get.bind(installed.area);
    const gate = deferred();
    const reading = deferred();
    vi.spyOn(installed.area, "get").mockImplementationOnce(async (keys) => {
      const snapshot = await original(keys);
      reading.resolve();
      await gate.promise;
      return snapshot;
    });

    const pending = commitRecoveryRestore(preview);
    await reading.promise;
    controller.abort();
    gate.resolve();

    await expect(pending).resolves.toEqual({ ok: false, code: "authority_revoked" });
    expectUntouched(installed, before);
    // The same account confirmed again means a new signal, but the preview keeps the one it was made with.
    await expect(commitRecoveryRestore(preview)).resolves.toEqual({ ok: false, code: "authority_revoked" });
    expectUntouched(installed, before);
  });

  it("does not even ask for the lock with a preview whose authority is already gone", async () => {
    const installed = install(inRecovery());
    const controller = new AbortController();
    const preview = await previewOf(sourceOf(), controller.signal);
    controller.abort();
    const connect = vi.spyOn(installed.runtime, "connect");

    await expect(commitRecoveryRestore(preview)).resolves.toEqual({ ok: false, code: "authority_revoked" });
    expect(connect).not.toHaveBeenCalled();
  });

  it("gives a revoked preview no answer about what is stored, not even that it was already restored", async () => {
    const installed = install(inRecovery());
    const controller = new AbortController();
    const preview = await previewOf(sourceOf(), controller.signal);
    await expect(commitRecoveryRestore(preview)).resolves.toMatchObject({ ok: true, value: { status: "restored" } });
    // The retry gets past the checks before and under the lock, then loses its authority while reading.
    const original = installed.area.get.bind(installed.area);
    const gate = deferred();
    const reading = deferred();
    vi.spyOn(installed.area, "get").mockImplementationOnce(async (keys) => {
      const snapshot = await original(keys);
      reading.resolve();
      await gate.promise;
      return snapshot;
    });

    const retry = commitRecoveryRestore(preview);
    await reading.promise;
    controller.abort();
    gate.resolve();

    await expect(retry).resolves.toEqual({ ok: false, code: "authority_revoked" });
    expect(installed.area.writeCount()).toBe(1);
  });

  it("reports a storage read that fails under the lock, and writes nothing", async () => {
    const installed = install(inRecovery());
    const preview = await previewOf();
    const before = installed.area.snapshot();
    vi.spyOn(installed.area, "get").mockRejectedValueOnce(new Error("PRIVATE_READ_PROBE"));

    await expect(commitRecoveryRestore(preview)).resolves.toEqual({ ok: false, code: "storage_read_failed" });
    expectUntouched(installed, before);
  });

  it("keeps another account's newest data when that account wrote after the preview (A11)", async () => {
    const installed = install(inRecovery());
    const preview = await previewOf();
    const bob = await new BrowserStorageContactsRepository().upsertNickname(BOB, { identity: { username: "erin", threadsUserId: "500" }, nickname: "Erin", now: LATER });

    await expect(commitRecoveryRestore(preview)).resolves.toMatchObject({ ok: true, value: { status: "restored" } });

    const after = installed.area.snapshot() as { directories: Record<string, { contacts: Record<string, unknown> }> };
    expect(after.directories[BOB_DIR].contacts[bob.id]).toEqual(bob);
    expect(after.directories[ALICE_DIR]).toEqual(preview.candidate.record);
  });

  it("refuses an old preview after this account's data was cleared in the meantime (A11)", async () => {
    const installed = install(inRecovery());
    const preview = await previewOf();
    await expect(clearDamagedOwnerDirectory(ALICE)).resolves.toEqual({ ok: true });
    const before = installed.area.snapshot();

    await expect(commitRecoveryRestore(preview)).resolves.toEqual({ ok: false, code: "concurrent_change" });
    expectUntouched(installed, before, 1);
  });

  it("refuses an old preview after this account was bound to a new Directory (A11)", async () => {
    const installed = install(withoutAlice());
    const preview = await previewOf();
    await new BrowserStorageContactsRepository().upsertNickname(ALICE, { identity: { username: "zed" }, nickname: "Zed", now: LATER });
    const before = installed.area.snapshot();

    await expect(commitRecoveryRestore(preview)).resolves.toEqual({ ok: false, code: "concurrent_change" });
    expectUntouched(installed, before, 1);
  });

  it("serializes against another Dashboard's clear through the lock, across separate module instances (T3)", async () => {
    const installed = install(inRecovery());
    const preview = await previewOf();
    vi.resetModules();
    // Another Dashboard tab: its own module instances, its own queue, the same storage and the same lock.
    const otherTab = await import("../../src/storage/directoryAccess");
    const original = installed.area.get.bind(installed.area);
    const inside = deferred();
    const release = deferred();
    vi.spyOn(installed.area, "get").mockImplementationOnce(async (keys) => {
      const snapshot = await original(keys);
      inside.resolve();
      await release.promise;
      return snapshot;
    });
    const clearing = otherTab.clearDamagedOwnerDirectory(ALICE); // holds the lock while its read is held
    await inside.promise;
    const queued = deferred();
    const connect = installed.runtime.connect.bind(installed.runtime);
    vi.spyOn(installed.runtime, "connect").mockImplementation((info) => {
      const port = connect(info);
      queued.resolve();
      return port;
    });

    const pending = commitRecoveryRestore(preview);
    await queued.promise;
    release.resolve();

    await expect(clearing).resolves.toEqual({ ok: true });
    await expect(pending).resolves.toEqual({ ok: false, code: "concurrent_change" });
    expect(installed.area.writeCount()).toBe(1);
    expect((installed.area.snapshot().accountBindings as Record<string, string>)[ALICE]).toBeUndefined();
  });

  it("reports a write that fails, leaves storage as it was, and can simply be retried (A14)", async () => {
    const installed = install(inRecovery());
    const before = installed.area.snapshot();
    const preview = await previewOf();
    vi.spyOn(installed.area, "set").mockRejectedValueOnce(new Error("QUOTA_BYTES quota exceeded"));

    await expect(commitRecoveryRestore(preview)).resolves.toEqual({ ok: false, code: "storage_write_failed" });
    expect(installed.area.snapshot()).toEqual(before);
    expect(installed.clear).not.toHaveBeenCalled();
    expect(installed.remove).not.toHaveBeenCalled();

    await expect(commitRecoveryRestore(preview)).resolves.toMatchObject({ ok: true, value: { status: "restored" } });
  });

  it("does not claim success when the read-back fails, and a retry finds the write instead of repeating it (A14)", async () => {
    const installed = install(inRecovery());
    const preview = await previewOf();
    const original = installed.area.get.bind(installed.area);
    let reads = 0;
    vi.spyOn(installed.area, "get").mockImplementation(async (keys) => {
      reads += 1;
      if (reads === 2) throw new Error("read-back lost");
      return original(keys);
    });

    await expect(commitRecoveryRestore(preview)).resolves.toEqual({ ok: false, code: "verification_failed" });
    // The write landed and is not rolled back.
    expect((installed.area.snapshot().directories as Record<string, unknown>)[ALICE_DIR]).toEqual(preview.candidate.record);
    expect(installed.area.writeCount()).toBe(1);

    await expect(commitRecoveryRestore(preview)).resolves.toEqual({ ok: true, value: { status: "already_restored", summary: preview.candidate.summary } });
    expect(installed.area.writeCount()).toBe(1);
    expect(installed.clear).not.toHaveBeenCalled();
    expect(installed.remove).not.toHaveBeenCalled();
  });

  it("sends a preview's write once: after a result it cannot confirm, a retry only looks, and asks for a new analysis (T7)", async () => {
    const installed = install(inRecovery());
    const before = installed.area.snapshot();
    const preview = await previewOf();
    // Storage accepts the write, yet what is read back is not the candidate.
    const set = vi.spyOn(installed.area, "set").mockResolvedValueOnce(undefined);

    await expect(commitRecoveryRestore(preview)).resolves.toEqual({ ok: false, code: "verification_failed" });
    await expect(commitRecoveryRestore(preview)).resolves.toEqual({ ok: false, code: "concurrent_change" });

    expect(set).toHaveBeenCalledTimes(1);
    expect(installed.area.snapshot()).toEqual(before);
    expect(installed.clear).not.toHaveBeenCalled();
    expect(installed.remove).not.toHaveBeenCalled();
  });

  it("does not claim success when what it reads back is not the candidate", async () => {
    const installed = install(inRecovery());
    const before = installed.area.snapshot();
    const preview = await previewOf();
    const original = installed.area.get.bind(installed.area);
    let reads = 0;
    vi.spyOn(installed.area, "get").mockImplementation(async (keys) => {
      reads += 1;
      return reads === 2 ? structuredClone(before) : original(keys);
    });

    await expect(commitRecoveryRestore(preview)).resolves.toEqual({ ok: false, code: "verification_failed" });
  });

  it("applies a doubled confirmation once (A14)", async () => {
    const installed = install(inRecovery());
    const preview = await previewOf();

    const results = await Promise.all([commitRecoveryRestore(preview), commitRecoveryRestore(preview)]);

    expect(results.map((result) => result.ok && result.value.status)).toEqual(["restored", "already_restored"]);
    expect(installed.area.writeCount()).toBe(1);
  });

  it("does not take another preview of the same file as already done: its rebuilt conflicts differ (A14)", async () => {
    // Two contacts share a stable ID, so each preview mints its own conflict ID.
    const dump = recoveryImportFixture();
    recoveryDirectory(dump).contacts.c2 = contact("c2", "dave", "300");
    const installed = install(inRecovery(dump));
    const first = await previewOf(sourceOf(dump));
    const second = await previewOf(sourceOf(dump));
    expect(Object.keys(first.candidate.record.identityConflicts)).not.toEqual(Object.keys(second.candidate.record.identityConflicts));

    await expect(commitRecoveryRestore(first)).resolves.toMatchObject({ ok: true, value: { status: "restored" } });
    await expect(commitRecoveryRestore(second)).resolves.toEqual({ ok: false, code: "concurrent_change" });
    expect(installed.area.writeCount()).toBe(1);
  });

  it("refuses a normal non-empty account with a new preview, whatever the file (A5)", async () => {
    const installed = install(twoAccounts());
    const before = installed.area.snapshot();

    await expect(previewRecoveryRestore({ source: sourceOf(), now: LATER, signal: new AbortController().signal })).resolves.toEqual({ ok: false, code: "target_not_empty" });
    expectUntouched(installed, before);
  });
});
