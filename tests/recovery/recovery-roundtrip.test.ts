import { afterEach, describe, expect, it, vi } from "vitest";

import type { ThreadContact } from "../../src/domain/contact";
import type { ContactTombstone } from "../../src/domain/tombstone";
import { exportDirectory } from "../../src/portability/exportBackup";
import { parseBackupText } from "../../src/portability/parseBackup";
import { recoveryStateFor } from "../../src/recovery/RecoveryCoordinator";
import { createRecoveryDump, serializeRecoveryDump } from "../../src/recovery/exportRecoveryDump";
import { parseRecoveryText } from "../../src/recovery/recoveryImport";
import { commitRecoveryRestore, previewRecoveryRestore } from "../../src/recovery/recoveryRestore";
import type { RecoveryPreview } from "../../src/recovery/recoveryTarget";
import { validateStorageHealth } from "../../src/recovery/validateStorageHealth";
import { BrowserStorageContactsRepository } from "../../src/storage/BrowserStorageContactsRepository";
import { __resetDirectoryAccessQueueForTests, clearDamagedOwnerDirectory, readOwnerDirectory } from "../../src/storage/directoryAccess";
import { installDirectoryLockArbiter } from "../../src/storage/directoryLock";
import { __resetMigrationCoordinatorForTests } from "../../src/storage/migrations";
import { installFakeChrome, type FakeStorageArea } from "../fixtures/storage/fakeChromeStorage";
import { createFakePortRuntime } from "../fixtures/storage/fakePortRuntime";
import { ALICE, ALICE_DIR, AT, BOB, BOB_DIR, twoAccounts, withDirectory } from "../fixtures/storage/recoveryStorage";

/**
 * Recovery Restore 1.1.0 end to end over the real storage code (Task 6; A1-A4, A14): a Directory damaged the way the
 * old username fallback damaged one, exported as a recovery file, restored - after a clear, or straight over the
 * damaged Directory - and then exported as an ordinary backup that the backup importer accepts. Synthetic data at the
 * scale of the case that prompted this (125 contacts, 1 deleted record), with nothing of that case in it.
 */
const LATER = "2026-09-26T00:00:00.000Z";

/** 125 contacts, 123 with a stable ID, one with a note; one deleted record; and one stale `threads:` entry. */
function damagedAlice() {
  const contacts: Record<string, ThreadContact> = {};
  const identityIndex: Record<string, string> = {};
  for (let i = 0; i < 125; i += 1) {
    const id = `c${i}`;
    const contact: ThreadContact = {
      id,
      username: `person${i}`,
      nickname: `Nick ${i}`,
      createdAt: AT,
      updatedAt: AT,
      identityUpdatedAt: AT,
      ...(i < 123 ? { threadsUserId: String(5000 + i) } : {}),
      ...(i === 7 ? { note: "  a note, spaces kept  " } : {}),
    };
    contacts[id] = contact;
    identityIndex[`username:${contact.username}`] = id;
    if (contact.threadsUserId) identityIndex[`threads:${contact.threadsUserId}`] = id;
  }
  // What `attachStableIdentity` used to leave: a second numeric entry for c3, which still stores 5003.
  identityIndex["threads:9003"] = "c3";
  const tombstones: Record<string, ContactTombstone> = {
    gone: { contactId: "gone", username: "former", threadsUserId: "4999", createdAt: AT, deletedAt: AT, reason: "user_deleted" },
  };
  return { directoryId: ALICE_DIR, contacts, tombstones, identityIndex, identityConflicts: {} };
}

function install(raw: Record<string, unknown>): FakeStorageArea {
  const area = installFakeChrome(raw);
  Object.assign(chrome, { runtime: createFakePortRuntime() });
  installDirectoryLockArbiter();
  return area;
}

/** What the Recovery page's export would save for Alice right now. */
function recoveryFileFor(area: FakeStorageArea): string {
  const dump = createRecoveryDump({ raw: area.snapshot(), ownerThreadsUserId: ALICE, exportedAt: AT });
  if (!dump) throw new Error("Alice is not in Recovery");
  return serializeRecoveryDump(dump);
}

async function previewFrom(text: string): Promise<RecoveryPreview> {
  const source = parseRecoveryText(text, ALICE);
  if (!source.ok) throw new Error(source.code);
  const preview = await previewRecoveryRestore({ source: source.value, now: LATER, signal: new AbortController().signal });
  if (!preview.ok) throw new Error(preview.code);
  return preview.value;
}

async function expectRestoredAndExportable(original: ReturnType<typeof damagedAlice>) {
  const { directory } = await readOwnerDirectory(ALICE);
  expect(directory?.contacts).toEqual(original.contacts);
  expect(directory?.tombstones).toEqual(original.tombstones);
  expect(directory?.identityIndex).not.toHaveProperty("threads:9003");
  expect(Object.keys(directory!.identityIndex)).toHaveLength(248);

  // An ordinary backup of the restored Directory, read back by the ordinary importer.
  const exported = exportDirectory(
    { directoryId: directory!.directoryId, contacts: new Map(Object.entries(directory!.contacts)), tombstones: new Map(Object.entries(directory!.tombstones)) },
    { threadsUserId: ALICE, username: "alice" },
    LATER,
  );
  if (!exported.ok) throw new Error("the restored Directory did not export");
  const parsed = parseBackupText(exported.json);
  if (!parsed.ok) throw new Error(parsed.error.code);
  expect(parsed.backup.directoryId).toBe(ALICE_DIR);
  expect(Object.fromEntries(parsed.backup.contacts.map((contact) => [contact.id, contact]))).toEqual(original.contacts);
  expect(parsed.backup.tombstones).toEqual([original.tombstones.gone]);
  expect(parsed.backup.contacts.map((contact) => contact.id)).not.toContain("gone");
}

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, "chrome");
  __resetDirectoryAccessQueueForTests();
  __resetMigrationCoordinatorForTests();
});

describe("recovery restore, end to end", () => {
  it("the old username fallback no longer damages a Directory this way (A1)", async () => {
    const area = install(twoAccounts());
    const repository = new BrowserStorageContactsRepository();
    await repository.upsertNickname(ALICE, { identity: { username: "person3", threadsUserId: "5003" }, nickname: "Nick 3", now: AT });
    const before = area.snapshot();

    await expect(repository.attachStableIdentity(ALICE, { username: "person3", threadsUserId: "9003", observedAt: LATER })).resolves.toMatchObject({ type: "identity-mismatch" });

    expect(area.snapshot()).toEqual(before);
    expect(recoveryStateFor(area.snapshot(), ALICE)).toEqual({ kind: "none" });
  });

  it("export -> clear -> restore brings the same account's contacts and deleted records back, then exports as a normal backup (A3)", async () => {
    const original = damagedAlice();
    const area = install(withDirectory(ALICE_DIR, structuredClone(original)));
    expect(recoveryStateFor(area.snapshot(), ALICE)).toEqual({ kind: "directory", code: "DIRECTORY_INVALID" });
    const file = recoveryFileFor(area);

    await expect(clearDamagedOwnerDirectory(ALICE)).resolves.toEqual({ ok: true });
    const preview = await previewFrom(file);
    expect(preview.target.operation).toBe("restore_empty");
    expect(preview.candidate.summary).toEqual({
      contacts: 125,
      tombstones: 1,
      rebuiltIndexEntries: 248,
      rebuiltConflicts: 0,
      originalIndexEntries: 249,
      originalConflicts: 0,
      identityMismatchCount: 1,
    });
    await expect(commitRecoveryRestore(preview)).resolves.toMatchObject({ ok: true, value: { status: "restored" } });

    expect(validateStorageHealth(area.snapshot())).toEqual({ kind: "healthy" });
    await expectRestoredAndExportable(original);
  });

  it("restores straight over the damaged Directory, with no empty Directory in between (A2, A4)", async () => {
    const original = damagedAlice();
    const area = install(withDirectory(ALICE_DIR, structuredClone(original)));
    const file = recoveryFileFor(area);
    const writes: unknown[] = [];
    const realSet = area.set.bind(area);
    vi.spyOn(area, "set").mockImplementation(async (values) => {
      writes.push(structuredClone(values));
      return realSet(values);
    });

    const preview = await previewFrom(file);
    expect(preview.target.operation).toBe("rebuild_damaged");
    await expect(commitRecoveryRestore(preview)).resolves.toMatchObject({ ok: true, value: { status: "restored" } });

    // One write, and it is the finished Directory: Alice is never bound to an empty one on the way.
    expect(writes).toHaveLength(1);
    expect((writes[0] as { directories: Record<string, { contacts: object }> }).directories[ALICE_DIR].contacts).toEqual(original.contacts);
    await expectRestoredAndExportable(original);
  });

  it("keeps a restore it cannot confirm, and a retry with the same preview finds it instead of writing again (A14)", async () => {
    const original = damagedAlice();
    const area = install(withDirectory(ALICE_DIR, structuredClone(original)));
    const preview = await previewFrom(recoveryFileFor(area));
    const realGet = area.get.bind(area);
    let reads = 0;
    vi.spyOn(area, "get").mockImplementation(async (keys) => {
      reads += 1;
      if (reads === 2) throw new Error("read-back lost");
      return realGet(keys);
    });

    await expect(commitRecoveryRestore(preview)).resolves.toEqual({ ok: false, code: "verification_failed" });
    await expect(commitRecoveryRestore(preview)).resolves.toMatchObject({ ok: true, value: { status: "already_restored" } });

    expect(area.writeCount()).toBe(1);
    await expectRestoredAndExportable(original);
  });

  it("leaves another account's damaged Directory exactly as it was stored", async () => {
    const original = damagedAlice();
    const bobDamaged = { directoryId: "not-bob", contacts: { x: { nickname: "PRIVATE_BOB_PROBE" } } };
    const area = install(withDirectory(BOB_DIR, bobDamaged, withDirectory(ALICE_DIR, structuredClone(original))));
    const preview = await previewFrom(recoveryFileFor(area));

    await expect(commitRecoveryRestore(preview)).resolves.toMatchObject({ ok: true, value: { status: "restored" } });

    const after = area.snapshot() as { directories: Record<string, unknown>; accountBindings: Record<string, string> };
    expect(after.directories[BOB_DIR]).toEqual(bobDamaged);
    expect(after.accountBindings[BOB]).toBe(BOB_DIR);
    expect(recoveryStateFor(after, BOB)).toEqual({ kind: "directory", code: "DIRECTORY_INVALID" });
    expect(recoveryStateFor(after, ALICE)).toEqual({ kind: "none" });
  });
});
