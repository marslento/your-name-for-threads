import { afterEach, describe, expect, it, vi } from "vitest";

import { exportDirectory } from "../../src/portability/exportBackup";
import { ThreadContactSchema } from "../../src/portability/backupSchema";
import { buildRecoveryCandidate, parseRecoveryFile, parseRecoveryText, type RecoverySource } from "../../src/recovery/recoveryImport";
import { validateStorageHealth } from "../../src/recovery/validateStorageHealth";
import { migrateStorage } from "../../src/storage/migrations";
import { recoveryDirectory, recoveryImportFixture } from "../fixtures/storage/recoveryImport";
import { ALICE, ALICE_DIR, AT, BOB, BOB_DIR, contact } from "../fixtures/storage/recoveryStorage";

/**
 * The single-account recovery reader (Recovery Restore 1.1.0, spec F1-F7, A2 and A7-A10). A recovery file is unsigned
 * input: every durable record is held to the backup's own strict schema and invariants, the whole file is refused on
 * the first bad one, and the derived index and conflicts are never trusted - they are rebuilt from the contacts.
 */
type Dump = ReturnType<typeof recoveryImportFixture>;
const LATER = "2026-09-26T00:00:00.000Z";

const variant = (edit: (dump: Dump) => void): string => {
  const dump = recoveryImportFixture();
  edit(dump);
  return JSON.stringify(dump);
};
const dir = recoveryDirectory;
const parse = (text: string, owner = ALICE) => parseRecoveryText(text, owner);
const parsed = (text: string): RecoverySource => {
  const result = parse(text);
  if (!result.ok) throw new Error(`expected a readable file, got ${result.code}`);
  return result.value;
};
const built = (text: string) => {
  const result = buildRecoveryCandidate(parsed(text), LATER);
  if (!result.ok) throw new Error(`expected a candidate, got ${result.code}`);
  return result.value;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseRecoveryText + buildRecoveryCandidate: a readable file", () => {
  it("keeps every durable value as stored and rebuilds only the index (A2)", () => {
    const dump = recoveryImportFixture();
    // The file really is damaged: this is the index the loader refuses.
    expect(validateStorageHealth({ ...dump.storage, identityCache: {}, settings: {} })).toMatchObject({ kind: "directory_error" });

    const candidate = built(JSON.stringify(dump));

    expect(candidate.record.directoryId).toBe(ALICE_DIR);
    expect(candidate.record.contacts).toEqual(dump.storage.directories[ALICE_DIR].contacts);
    expect(candidate.record.tombstones).toEqual(dump.storage.directories[ALICE_DIR].tombstones);
    expect(candidate.record.contacts.c1.note).toBe("Keep note");
    expect(candidate.record.identityIndex).toEqual({ "username:carol": "c1", "threads:300": "c1" });
    expect(candidate.record.identityConflicts).toEqual({});
    expect(candidate.summary).toEqual({
      contacts: 1,
      tombstones: 1,
      rebuiltIndexEntries: 2,
      rebuiltConflicts: 0,
      originalIndexEntries: 3,
      originalConflicts: 0,
      identityMismatchCount: 1,
    });
    expect(candidate.identityMismatches).toEqual([{ contactId: "c1", username: "carol", storedThreadsUserId: "300", indexedThreadsUserId: "301" }]);
    // What would be written is exactly what the loader accepts.
    expect(migrateStorage({ schemaVersion: 4, directories: { [ALICE_DIR]: candidate.record }, accountBindings: { [ALICE]: ALICE_DIR } }).directories[ALICE_DIR]).toEqual(candidate.record);
  });

  it("returns the file's own metadata, owner and derived data as read, without changing it", () => {
    const text = JSON.stringify(recoveryImportFixture());
    const source = parsed(text);

    expect(source).toMatchObject({ ownerThreadsUserId: ALICE, exportedAt: AT, directoryId: ALICE_DIR });
    expect(source.originalDerived).toEqual({
      identityIndex: { "username:carol": "c1", "threads:300": "c1", "threads:301": "c1" },
      identityConflicts: {},
    });
    buildRecoveryCandidate(source, LATER);
    expect(source).toEqual(parsed(text));
  });

  it("accepts any key order (it is the same data)", () => {
    const dump = recoveryImportFixture();
    const reordered = Object.fromEntries(Object.entries(dump).reverse());
    const contacts = dir(dump).contacts;
    contacts.c1 = Object.fromEntries(Object.entries(contacts.c1).reverse());

    expect(built(JSON.stringify(reordered)).record.contacts).toEqual(dir(recoveryImportFixture()).contacts);
  });

  it.each([
    ["null", null],
    ["an array", [["username:carol", "c1"]]],
    ["a string", "PRIVATE_INDEX_PROBE"],
  ])("does not trust a derived index that is %s: it is rebuilt, and its size is unknown, not 0 (A9)", (_name, value) => {
    const candidate = built(variant((dump) => {
      dir(dump).identityIndex = value;
      dir(dump).identityConflicts = value;
    }));

    expect(candidate.record.identityIndex).toEqual({ "username:carol": "c1", "threads:300": "c1" });
    expect(candidate.summary).toMatchObject({ originalIndexEntries: null, originalConflicts: null, identityMismatchCount: 0 });
  });

  it("reads an absent derived index as empty, as the loader does", () => {
    const candidate = built(variant((dump) => {
      delete dir(dump).identityIndex;
      delete dir(dump).identityConflicts;
    }));

    expect(candidate.summary).toMatchObject({ originalIndexEntries: 0, originalConflicts: 0, rebuiltIndexEntries: 2 });
  });

  it("ignores a huge derived map instead of trusting any of it", () => {
    const candidate = built(variant((dump) => {
      dir(dump).identityIndex = Object.fromEntries(Array.from({ length: 50_000 }, (_, i) => [`username:ghost${i}`, "missing"]));
    }));

    expect(candidate.record.identityIndex).toEqual({ "username:carol": "c1", "threads:300": "c1" });
    expect(candidate.summary.originalIndexEntries).toBe(50_000);
  });

  it("gives two contacts sharing a stable ID a new pending conflict, and picks neither (A9)", () => {
    const candidate = built(variant((dump) => {
      dir(dump).contacts.c2 = contact("c2", "dave", "300");
      dir(dump).identityConflicts = { stale: { id: "stale", threadsUserId: "999", contactIds: ["c1"], detectedAt: AT } };
    }));

    expect(candidate.record.identityIndex).toEqual({ "username:carol": "c1", "username:dave": "c2" });
    const conflicts = Object.values(candidate.record.identityConflicts);
    expect(conflicts).toEqual([{ id: expect.any(String), threadsUserId: "300", contactIds: ["c1", "c2"], detectedAt: LATER }]);
    expect(conflicts[0].id).not.toBe("stale");
    expect(candidate.record.contacts.c1.threadsUserId).toBe("300");
    expect(candidate.record.contacts.c2.threadsUserId).toBe("300");
    expect(candidate.summary).toMatchObject({ rebuiltConflicts: 1, originalConflicts: 1 });
  });

  it("counts every index entry that names a different stable ID, but keeps only 20 to show", () => {
    const candidate = built(variant((dump) => {
      dir(dump).identityIndex = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`threads:${500 + i}`, "c1"]));
    }));

    expect(candidate.summary.identityMismatchCount).toBe(25);
    expect(candidate.identityMismatches).toHaveLength(20);
    expect(candidate.identityMismatches[0]).toEqual({ contactId: "c1", username: "carol", storedThreadsUserId: "300", indexedThreadsUserId: "500" });
  });

  it("names a mismatch for a contact with no stored ID too, and nothing for entries that are not a numeric ID", () => {
    const candidate = built(variant((dump) => {
      delete dir(dump).contacts.c1.threadsUserId;
      dir(dump).identityIndex = { "threads:301": "c1", "threads:abc": "c1", "threads:302": "missing", "username:carol": "c9" };
    }));

    expect(candidate.identityMismatches).toEqual([{ contactId: "c1", username: "carol", indexedThreadsUserId: "301" }]);
  });
});

describe("parseRecoveryText: files it does not read (F1, F6, A7)", () => {
  const backupText = () => {
    const exported = exportDirectory(
      { directoryId: ALICE_DIR, contacts: new Map([["c1", contact("c1", "carol", "300")]]), tombstones: new Map() },
      { threadsUserId: ALICE, username: "alice" },
      AT,
    );
    if (!exported.ok) throw new Error("the synthetic backup did not export");
    return exported.json;
  };

  it.each([
    ["text that is not JSON", "{not json", "invalid_json"],
    ["a JSON array", "[]", "unsupported_format"],
    ["a JSON string", '"your-name-for-threads-recovery"', "unsupported_format"],
    ["a backup, which has its own importer", backupText(), "unsupported_format"],
    ["another format tag", variant((d) => { (d as Record<string, unknown>).format = "your-name-for-threads-backup"; }), "unsupported_format"],
    ["a newer recovery version", variant((d) => { (d as Record<string, unknown>).recoveryVersion = 2; }), "unsupported_version"],
    ["a version written as text", variant((d) => { (d as Record<string, unknown>).recoveryVersion = "1"; }), "unsupported_version"],
    ["a global recovery file", variant((d) => { d.scope = "global"; }), "unsupported_scope"],
    ["a file with no scope", variant((d) => { delete (d as Record<string, unknown>).scope; }), "unsupported_scope"],
    ["stored data from an older schema", variant((d) => { d.storage.schemaVersion = 3; }), "unsupported_version"],
  ])("refuses %s", (_name, text, code) => {
    expect(parse(text)).toEqual({ ok: false, code });
  });

  it("refuses another account's file, with no way to override it (F2, A7)", () => {
    const text = JSON.stringify(recoveryImportFixture());

    expect(parse(text, BOB)).toEqual({ ok: false, code: "owner_mismatch" });
  });

  it.each<[string, (dump: Dump) => void]>([
    ["an extra top-level field", (d) => { (d as Record<string, unknown>).contacts = []; }],
    ["a backup dressed up as a recovery file", (d) => { Object.assign(d, { backupVersion: 2, exportedBy: { threadsUserId: ALICE, username: "alice" } }); }],
    ["no notice", (d) => { delete (d as Record<string, unknown>).notice; }],
    ["an export time that is not a timestamp", (d) => { d.exportedAt = "yesterday"; }],
    ["an extension version that is not text", (d) => { (d as Record<string, unknown>).extensionVersion = 1; }],
    ["a code the format does not define", (d) => { d.code = "PLEASE_REPAIR"; }],
    ["storage that is not an object", (d) => { (d as Record<string, unknown>).storage = [d.storage]; }],
    ["settings in a single-account file", (d) => { (d.storage as Record<string, unknown>).settings = {}; }],
    ["the identity cache in a single-account file", (d) => { (d.storage as Record<string, unknown>).identityCache = {}; }],
    ["no bindings", (d) => { delete (d.storage as Record<string, unknown>).accountBindings; }],
    ["two Directories", (d) => { (d.storage.directories as Record<string, unknown>)[BOB_DIR] = { directoryId: BOB_DIR, contacts: {}, tombstones: {} }; }],
    ["another account's binding too", (d) => { (d.storage.accountBindings as Record<string, string>)[BOB] = BOB_DIR; }],
    ["no Directory", (d) => { d.storage.directories = {}; }],
    ["a binding to a Directory that is not in the file", (d) => { d.storage.accountBindings = { [ALICE]: BOB_DIR }; }],
    ["a binding key that is not a Threads user ID", (d) => { d.storage.accountBindings = { alice: ALICE_DIR } as never; }],
    ["a Directory stored under another ID", (d) => { dir(d).directoryId = "not-the-key-it-is-stored-under"; }],
    ["a Directory with a field the format does not have", (d) => { dir(d).extraField = { anything: [1, 2, 3] }; }],
    ["contacts that are missing", (d) => { delete (dir(d) as Record<string, unknown>).contacts; }],
    ["contacts that are a list", (d) => { (dir(d) as Record<string, unknown>).contacts = [dir(d).contacts.c1]; }],
    ["deleted records that are null", (d) => { (dir(d) as Record<string, unknown>).tombstones = null; }],
  ])("refuses %s as a file it cannot trust (F2, F3, F6)", (_name, edit) => {
    expect(parse(variant(edit))).toEqual({ ok: false, code: "invalid_structure" });
  });

  it("refuses a Directory ID the storage layer reserves", () => {
    const text = JSON.stringify(recoveryImportFixture()).replaceAll(`"${ALICE_DIR}"`, '"__proto__"');
    expect(JSON.parse(text).storage.accountBindings[ALICE]).toBe("__proto__");

    expect(parse(text)).toEqual({ ok: false, code: "invalid_structure" });
  });
});

describe("parseRecoveryText: one bad record refuses the whole file (F3, A8)", () => {
  const record = (edit: (dump: Dump) => void) => parse(variant(edit));

  it.each<[string, (dump: Dump) => void, string, string]>([
    ["a blank nickname", (d) => { dir(d).contacts.c1.nickname = " "; }, "contacts.c1.nickname", "invalid_field"],
    ["a nickname with untrimmed space", (d) => { dir(d).contacts.c1.nickname = " CAROL"; }, "contacts.c1.nickname", "invalid_field"],
    ["a 26-character nickname", (d) => { dir(d).contacts.c1.nickname = "x".repeat(26); }, "contacts.c1.nickname", "invalid_field"],
    ["a 201-character note", (d) => { dir(d).contacts.c1.note = "n".repeat(201); }, "contacts.c1.note", "invalid_field"],
    ["a stable ID that is not numeric", (d) => { dir(d).contacts.c1.threadsUserId = "30x"; }, "contacts.c1.threadsUserId", "invalid_field"],
    ["an impossible date", (d) => { dir(d).contacts.c1.updatedAt = "2026-02-30T00:00:00.000Z"; }, "contacts.c1.updatedAt", "invalid_field"],
    ["a username not in canonical form", (d) => { dir(d).contacts.c1.username = "@Carol"; }, "contacts.c1.username", "invalid_field"],
    ["a contact field the format does not have", (d) => { dir(d).contacts.c1.avatar = "x"; }, "contacts.c1.avatar", "invalid_field"],
    ["a contact that is not an object", (d) => { (dir(d).contacts as Record<string, unknown>).c1 = "carol"; }, "contacts.c1", "invalid_field"],
    ["a contact stored under another key", (d) => { dir(d).contacts = { x: dir(d).contacts.c1 }; }, "contacts.x.id", "key_mismatch"],
    ["a deleted record stored under another key", (d) => { dir(d).tombstones = { x: dir(d).tombstones.gone }; }, "tombstones.x.contactId", "key_mismatch"],
    ["a deleted record with an unknown reason", (d) => { dir(d).tombstones.gone.reason = "expired"; }, "tombstones.gone.reason", "invalid_field"],
    ["a deleted record field the format does not have", (d) => { dir(d).tombstones.gone.note = "x"; }, "tombstones.gone.note", "invalid_field"],
    ["a merge with no target", (d) => { dir(d).tombstones.gone.reason = "merged"; }, "tombstones.gone.mergedIntoContactId", "invalid_lineage"],
    ["a merge into itself", (d) => { Object.assign(dir(d).tombstones.gone, { reason: "merged", mergedIntoContactId: "gone" }); }, "tombstones.gone.mergedIntoContactId", "invalid_lineage"],
    ["a merge into a contact that is not there", (d) => { Object.assign(dir(d).tombstones.gone, { reason: "merged", mergedIntoContactId: "c404" }); }, "tombstones.gone.mergedIntoContactId", "invalid_lineage"],
    ["a contact that is also deleted", (d) => { dir(d).tombstones = { c1: { ...dir(d).tombstones.gone, contactId: "c1" } }; }, "tombstones.c1", "invalid_lineage"],
    ["two contacts with one username", (d) => { dir(d).contacts.c2 = contact("c2", "carol", "301"); }, "contacts.c2.username", "duplicate_username"],
  ])("refuses %s, and says where", (_name, edit, path, code) => {
    const result = record(edit);

    expect(result).toMatchObject({ ok: false, code: "invalid_records", issues: expect.arrayContaining([{ path, code }]) });
    expect(result).not.toHaveProperty("value");
  });

  it("refuses a contact kept under a key the storage layer reserves", () => {
    const text = variant((d) => {
      dir(d).contacts = { RESERVED: { ...dir(d).contacts.c1, id: "RESERVED" } };
    }).replaceAll('"RESERVED"', '"__proto__"');

    expect(parse(text)).toMatchObject({ ok: false, code: "invalid_records", issues: [{ path: "contacts.__proto__.id", code: "invalid_field" }] });
  });

  it("counts every problem but lists 20, each at most 200 characters long", () => {
    const result = record((d) => {
      // First, so it is among the 20 listed.
      dir(d).contacts["k".repeat(1_000)] = { ...contact("k".repeat(1_000), "long", "1"), nickname: "" };
      for (let i = 0; i < 25; i += 1) dir(d).contacts[`bad${i}`] = { ...contact(`bad${i}`, `user${i}`, "1"), nickname: "" };
    });

    expect(result).toMatchObject({ ok: false, code: "invalid_records", issueCount: 26 });
    if (result.ok || !result.issues) throw new Error("expected issues");
    expect(result.issues).toHaveLength(20);
    expect(Math.max(...result.issues.map((issue) => issue.path.length))).toBeLessThanOrEqual(200);
  });

  it("turns a validator that throws into a closed code, without its text", () => {
    vi.spyOn(ThreadContactSchema, "safeParse").mockImplementation(() => {
      throw new RangeError("PRIVATE_EXCEPTION_PROBE");
    });

    const result = parse(JSON.stringify(recoveryImportFixture()));

    expect(result).toEqual({ ok: false, code: "invalid_structure" });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
});

describe("size limits come before any record is read (F5, A10)", () => {
  const records = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`t${i}`, {}]));

  it.each([
    ["20,001 contacts", 20_001, 0],
    ["10,001 contacts and 10,000 deleted records", 10_001, 10_000],
  ])("refuses %s as too many, before a single one is validated", (_name, contacts, tombstones) => {
    const spy = vi.spyOn(ThreadContactSchema, "safeParse");
    const text = variant((d) => {
      dir(d).contacts = records(contacts) as never;
      dir(d).tombstones = records(tombstones) as never;
    });

    expect(parse(text)).toEqual({ ok: false, code: "too_many_records" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("accepts exactly 20,000 records", () => {
    const text = variant((d) => {
      dir(d).contacts = {};
      dir(d).tombstones = Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`t${i}`, { contactId: `t${i}`, username: `u${i}`, createdAt: AT, deletedAt: AT, reason: "user_deleted" }])) as never;
    });

    expect(parse(text)).toMatchObject({ ok: true });
  });

  // jsdom's File has no working `text()`, so the file carries its own (as the import-flow tests do).
  const fileOf = (text: string) => Object.assign(new File([text], "your-name-for-threads-recovery.json", { type: "application/json" }), { text: vi.fn(async () => text) });

  it("refuses a file over 10 MiB without reading it", async () => {
    const file = fileOf("{}");
    Object.defineProperty(file, "size", { value: 10 * 1024 * 1024 + 1 });

    await expect(parseRecoveryFile(file, ALICE)).resolves.toEqual({ ok: false, code: "file_too_large" });
    expect(file.text).not.toHaveBeenCalled();
  });

  it("reads a file of exactly 10 MiB", async () => {
    const file = fileOf(JSON.stringify(recoveryImportFixture()));
    Object.defineProperty(file, "size", { value: 10 * 1024 * 1024 });

    await expect(parseRecoveryFile(file, ALICE)).resolves.toMatchObject({ ok: true, value: { directoryId: ALICE_DIR } });
    expect(file.text).toHaveBeenCalledTimes(1);
  });
});
