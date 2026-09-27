import { afterEach, describe, expect, it } from "vitest";

import { executeImport } from "../../src/dashboard/backup/executeImport";
import { analyzeRestore } from "../../src/portability/analyzeImport";
import type { BackupSnapshotV2 } from "../../src/portability/backupTypes";
import { buildRestoreCandidate } from "../../src/portability/buildCandidateSnapshot";
import { captureConcurrencyBaseline } from "../../src/portability/importConcurrency";
import { parseBackupText } from "../../src/portability/parseBackup";
import { validateCandidateSnapshot } from "../../src/portability/validateCandidate";
import { validateStorageHealth } from "../../src/recovery/validateStorageHealth";
import { BrowserDirectoryRepository } from "../../src/storage/BrowserDirectoryRepository";
import { __resetDirectoryAccessQueueForTests } from "../../src/storage/directoryAccess";
import { loadStorageWithQuarantine } from "../../src/storage/migrations";
import { installFakeChrome } from "../fixtures/storage/fakeChromeStorage";

const OWNER = "900";
const NOW = "2026-01-01T00:00:00.000Z";
const contact = { id: "legacy-contact", username: "alice", nickname: "Alice", createdAt: NOW, updatedAt: NOW, identityUpdatedAt: NOW };

function backup(directoryId: string): BackupSnapshotV2 {
  return {
    format: "threads-private-directory-backup", backupVersion: 2,
    exportedBy: { threadsUserId: OWNER, username: "owner" },
    directoryId, exportedAt: NOW, contacts: [contact], tombstones: [],
  };
}

function restore(source: BackupSnapshotV2) {
  const localBaseline = { directoryId: "", contacts: new Map(), tombstones: new Map() };
  return executeImport({
    ownerThreadsUserId: OWNER,
    repository: new BrowserDirectoryRepository(), clock: () => NOW, createUuid: () => "unused",
    session: {
      sessionId: "restore", lineage: "adoptable_lineage", mode: "restore", source, localBaseline,
      preflight: analyzeRestore(localBaseline, source), reviewDecisions: new Map(),
      concurrencyBaseline: captureConcurrencyBaseline("restore", localBaseline, source),
    },
  });
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
  __resetDirectoryAccessQueueForTests();
});

describe("untrusted backup storage keys", () => {
  it.each(["__proto__", "constructor", "prototype"])("rejects %s at parsing and the final restore gate without writing", async (directoryId) => {
    const source = backup(directoryId);
    const area = installFakeChrome({ schemaVersion: 4 });
    const before = area.snapshot();

    expect(parseBackupText(JSON.stringify(source))).toMatchObject({ ok: false, error: { code: "invalid_schema" } });
    expect(await restore(source)).toMatchObject({ status: "invalid_candidate", issues: [{ code: "invalid_directory_id" }] });
    expect(area.snapshot()).toEqual(before);
    expect(area.writeCount()).toBe(0);
  });

  it.each(["__proto__", "constructor", "prototype"])("also rejects %s for contact and tombstone keys", (id) => {
    const source = backup("legacy-dir");
    source.contacts[0] = { ...contact, id };
    expect(parseBackupText(JSON.stringify(source))).toMatchObject({ ok: false, error: { code: "invalid_schema" } });
    expect(validateCandidateSnapshot(buildRestoreCandidate(source))).toMatchObject({ ok: false, issues: [{ code: "invalid_contact_id", contactId: id }] });

    source.contacts = [];
    source.tombstones = [{ contactId: id, username: "alice", createdAt: NOW, deletedAt: NOW, reason: "user_deleted" }];
    expect(parseBackupText(JSON.stringify(source))).toMatchObject({ ok: false, error: { code: "invalid_schema" } });
    expect(validateCandidateSnapshot(buildRestoreCandidate(source))).toMatchObject({ ok: false, issues: [{ code: "invalid_contact_id", contactId: id }] });
  });

  it.each(["legacy-dir", "__defineGetter__"])("preserves permitted non-UUID ID %s through parse, restore, persistence and reload", async (directoryId) => {
    const area = installFakeChrome({ schemaVersion: 4 });
    const parsed = parseBackupText(JSON.stringify(backup(directoryId)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw parsed.error;

    expect(await restore(parsed.backup)).toMatchObject({ status: "success" });
    const { storage, quarantine } = await loadStorageWithQuarantine();
    expect(Object.hasOwn(storage.directories, directoryId)).toBe(true);
    expect(storage.accountBindings[OWNER]).toBe(directoryId);
    expect(storage.directories[directoryId].contacts[contact.id]).toEqual(contact);
    expect(quarantine.directories).toEqual({});
    expect(validateStorageHealth(area.snapshot())).toEqual({ kind: "healthy" });
  });

  it("loads previously persisted __proto__ keys without breaking any owner's binding", async () => {
    const record = {
      directoryId: "__proto__", contacts: { ["__proto__"]: { ...contact, id: "__proto__" } },
      tombstones: {}, identityIndex: { "username:alice": "__proto__" }, identityConflicts: {},
    };
    const otherRecord = { directoryId: "other-dir", contacts: {}, tombstones: {}, identityIndex: {}, identityConflicts: {} };
    const area = installFakeChrome(JSON.parse(JSON.stringify({
      schemaVersion: 4, directories: { ["__proto__"]: record, "other-dir": otherRecord },
      accountBindings: { [OWNER]: "__proto__", "901": "other-dir" },
    })));
    const before = area.snapshot();

    const { storage, quarantine } = await loadStorageWithQuarantine();
    expect(Object.hasOwn(storage.directories, "__proto__")).toBe(true);
    expect(storage.directories.__proto__).toEqual(record);
    expect(storage.directories.constructor).toBeUndefined();
    expect(storage.directories.__proto__.contacts.constructor).toBeUndefined();
    expect(quarantine.directories).toEqual({});
    const repository = new BrowserDirectoryRepository();
    await expect(repository.getDirectoryForOwner(OWNER)).resolves.toEqual(record);
    await expect(repository.getDirectoryForOwner("901")).resolves.toEqual(otherRecord);
    await expect(repository.getDirectoryById("constructor")).resolves.toBeUndefined();
    expect(validateStorageHealth(before)).toEqual({ kind: "healthy" });
    expect(area.snapshot()).toEqual(before);
    expect(area.writeCount()).toBe(0);
  });
});
