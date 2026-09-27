import { describe, expect, it } from "vitest";

import { buildRecoveryCandidate, parseRecoveryText, type RecoverySource } from "../../src/recovery/recoveryImport";
import { analyzeRecoveryTarget, prepareRecoveryWrite, recoveryApplied, type RecoveryPreview } from "../../src/recovery/recoveryTarget";
import { validateStorageHealth } from "../../src/recovery/validateStorageHealth";
import { migrateStorage } from "../../src/storage/migrations";
import { recoveryDirectory, recoveryImportFixture } from "../fixtures/storage/recoveryImport";
import { ALICE, ALICE_DIR, AT, BOB, BOB_DIR, contact, directory, twoAccounts, withDirectory } from "../fixtures/storage/recoveryStorage";

/**
 * Where a recovery file may go (Recovery Restore 1.1.0, spec section 7, T1-T3, T5-T6; A5, A6, A11, A13). Pure
 * decisions over raw storage: only this account's own damaged Directory holding exactly the file's records, or an
 * empty one. Nothing is ever merged, overwritten or cleared to make room.
 */
const LATER = "2026-09-26T00:00:00.000Z";
const CAROL = "300";

const source = (dump = recoveryImportFixture()): RecoverySource => {
  const result = parseRecoveryText(JSON.stringify(dump), ALICE);
  if (!result.ok) throw new Error(result.code);
  return result.value;
};
/** Alice's Directory as the file holds it: damaged (a stale `threads:301` entry) and set aside by the loader. */
const damaged = () => structuredClone(recoveryImportFixture().storage.directories[ALICE_DIR]) as Record<string, unknown>;
const inRecovery = () => withDirectory(ALICE_DIR, damaged());
const withoutAlice = (base = twoAccounts()) => ({
  ...base,
  directories: Object.fromEntries(Object.entries(base.directories as object).filter(([id]) => id !== ALICE_DIR)),
  accountBindings: { [BOB]: BOB_DIR },
});
const analyze = (raw: unknown, from = source()) => analyzeRecoveryTarget(raw, from);

function previewFor(raw: unknown, from = source()): RecoveryPreview {
  const target = analyzeRecoveryTarget(raw, from);
  const candidate = buildRecoveryCandidate(from, LATER);
  if (!target.ok || !candidate.ok) throw new Error("expected a preview");
  return { source: from, candidate: candidate.value, target: target.value, authoritySignal: new AbortController().signal };
}

describe("analyzeRecoveryTarget: where the file may go", () => {
  it("rebuilds this account's own damaged Directory when it holds exactly what the file holds", () => {
    const raw = inRecovery();
    const before = structuredClone(raw);

    expect(analyze(raw)).toEqual({ ok: true, value: { operation: "rebuild_damaged", baseline: { binding: ALICE_DIR, directory: damaged() } } });
    expect(raw).toEqual(before);
  });

  it("restores into an account that has no Directory (cleared, or never used), taking the file's Directory ID", () => {
    expect(analyze(withoutAlice())).toEqual({ ok: true, value: { operation: "restore_empty", baseline: { binding: null, directory: null } } });
  });

  it("restores into a truly empty Directory of this account", () => {
    const raw = withDirectory("dir-new", directory("dir-new"), { ...withoutAlice(), accountBindings: { [ALICE]: "dir-new", [BOB]: BOB_DIR } });

    expect(analyze(raw)).toMatchObject({ ok: true, value: { operation: "restore_empty", baseline: { binding: "dir-new", directory: directory("dir-new") } } });
  });

  it.each<[string, Record<string, unknown>]>([
    ["contacts", { contacts: { c9: contact("c9", "erin", "900") } }],
    ["only deleted records", { tombstones: { gone: { contactId: "gone", username: "former", createdAt: AT, deletedAt: AT, reason: "user_deleted" } } }],
    ["only a pending conflict", { identityConflicts: { k1: { id: "k1", threadsUserId: "900", contactIds: ["x", "y"], detectedAt: AT } } }],
  ])("refuses a healthy Directory with %s: it is not empty, and nothing is overwritten (A5)", (_name, extra) => {
    const raw = withDirectory(ALICE_DIR, directory(ALICE_DIR, extra));
    expect(validateStorageHealth(raw)).toEqual({ kind: "healthy" });
    const before = structuredClone(raw);

    expect(analyze(raw)).toEqual({ ok: false, code: "target_not_empty" });
    expect(raw).toEqual(before);
  });

  it("refuses the normal two-account storage for Alice (A5)", () => {
    expect(analyze(twoAccounts())).toEqual({ ok: false, code: "target_not_empty" });
  });

  it.each<[string, (dir: Record<string, unknown>) => void]>([
    ["a note that was edited since", (dir) => { (dir.contacts as Record<string, Record<string, unknown>>).c1.note = "Edited later"; }],
    ["a timestamp that differs", (dir) => { (dir.contacts as Record<string, Record<string, unknown>>).c1.updatedAt = LATER; }],
    ["a deleted record the file lacks", (dir) => { (dir.tombstones as Record<string, unknown>).gone2 = { contactId: "gone2", username: "x", createdAt: AT, deletedAt: AT, reason: "user_deleted" }; }],
    ["a contact the file lacks", (dir) => { (dir.contacts as Record<string, unknown>).c9 = contact("c9", "erin", "900"); }],
    ["a field the file cannot carry", (dir) => { dir.extraField = [1, 2, 3]; }],
  ])("refuses a damaged Directory with %s, and never picks the newer one by date (A6)", (_name, edit) => {
    const dir = damaged();
    edit(dir);
    const raw = withDirectory(ALICE_DIR, dir);
    expect(validateStorageHealth(raw)).toMatchObject({ kind: "directory_error" });

    expect(analyze(raw)).toEqual({ ok: false, code: "source_target_mismatch" });
  });

  it("tells a missing collection from an empty one (T1)", () => {
    const dump = recoveryImportFixture();
    recoveryDirectory(dump).tombstones = {};
    const from = source(dump);
    const missing = damaged();
    delete missing.tombstones;
    const empty = { ...damaged(), tombstones: {} };

    expect(analyze(withDirectory(ALICE_DIR, missing), from)).toEqual({ ok: false, code: "source_target_mismatch" });
    expect(analyze(withDirectory(ALICE_DIR, empty), from)).toMatchObject({ ok: true, value: { operation: "rebuild_damaged" } });
  });

  it("accepts the same records stored in another key order (A6)", () => {
    const dir = damaged();
    const contacts = dir.contacts as Record<string, Record<string, unknown>>;
    contacts.c1 = Object.fromEntries(Object.entries(contacts.c1).reverse());
    const raw = withDirectory(ALICE_DIR, Object.fromEntries(Object.entries(dir).reverse()));

    expect(analyze(raw)).toMatchObject({ ok: true, value: { operation: "rebuild_damaged" } });
  });

  it("refuses the file's own records stored and bound under another key: rebuilding would drop that Directory (T6)", () => {
    // Only the binding check can refuse this one: the record even claims the file's ID.
    const raw = { ...withoutAlice(), directories: { [BOB_DIR]: directory(BOB_DIR), "dir-other": damaged() }, accountBindings: { [ALICE]: "dir-other", [BOB]: BOB_DIR } };
    expect(validateStorageHealth(raw)).toMatchObject({ kind: "directory_error", directoryId: "dir-other" });

    expect(analyze(raw)).toEqual({ ok: false, code: "source_target_mismatch" });
  });

  it("refuses a damaged Directory whose own ID field is not the file's, though it is bound under the file's ID", () => {
    expect(analyze(withDirectory(ALICE_DIR, { ...damaged(), directoryId: "not-alice" }))).toEqual({ ok: false, code: "source_target_mismatch" });
  });

  it("refuses when this account is in Recovery for a different Directory than the file's", () => {
    const raw = { ...withoutAlice(), directories: { [BOB_DIR]: directory(BOB_DIR), "dir-other": { directoryId: "not-it" } }, accountBindings: { [ALICE]: "dir-other", [BOB]: BOB_DIR } };

    expect(analyze(raw)).toEqual({ ok: false, code: "source_target_mismatch" });
  });

  it.each<[string, () => Record<string, unknown>]>([
    ["another account's Directory", () => ({ ...withoutAlice(), directories: { [ALICE_DIR]: directory(ALICE_DIR) }, accountBindings: { [BOB]: ALICE_DIR } })],
    ["another account's Directory that is set aside", () => ({ ...withoutAlice(), directories: { [ALICE_DIR]: damaged() }, accountBindings: { [BOB]: ALICE_DIR } })],
    ["a Directory nobody is bound to", () => ({ ...withoutAlice(), directories: { ...withoutAlice().directories as object, [ALICE_DIR]: directory(ALICE_DIR) } })],
  ])("refuses a Directory ID already taken by %s, and leaves it alone (A13)", (_name, make) => {
    const raw = make();
    const before = structuredClone(raw);

    expect(analyze(raw)).toEqual({ ok: false, code: "directory_id_occupied" });
    expect(raw).toEqual(before);
  });

  it("refuses to rebuild a damaged Directory another account is bound to as well", () => {
    const raw = { ...inRecovery(), accountBindings: { [ALICE]: ALICE_DIR, [CAROL]: ALICE_DIR, [BOB]: BOB_DIR } };

    expect(analyze(raw)).toEqual({ ok: false, code: "directory_id_occupied" });
  });

  it.each<[string, unknown]>([
    ["nothing stored yet", {}],
    ["an older schema", { schemaVersion: 3, directory: { directoryId: "d" } }],
    ["current data with a leftover older key", { ...withoutAlice(), contacts: {} }],
    ["damage to the whole store", twoAccounts({ settings: 5 })],
    ["bindings that cannot be trusted", { ...withoutAlice(), accountBindings: { [BOB]: "missing" } }],
    ["storage that is not an object", "PRIVATE_ROOT_PROBE"],
  ])("does not touch %s: that belongs to the existing initialization and Recovery flows", (_name, raw) => {
    expect(analyze(raw)).toEqual({ ok: false, code: "unsupported_storage" });
  });

  it("does not let another account's damaged Directory block this one", () => {
    const raw = withDirectory(BOB_DIR, { directoryId: "not-bob", junk: [1] }, withoutAlice());

    expect(analyze(raw)).toMatchObject({ ok: true, value: { operation: "restore_empty" } });
  });

  it("gives a closed code, not an exception, for stored data too deep to compare", () => {
    let deep: unknown = [];
    for (let i = 0; i < 200_000; i += 1) deep = [deep];
    // Plain JSON.stringify copes; with a replacer, as the comparison needs, V8 recurses and runs out of stack.
    expect(() => JSON.stringify(deep, (_key, value: unknown) => value)).toThrow(RangeError);
    const dir = damaged();
    (dir.contacts as Record<string, Record<string, unknown>>).c1.extra = deep;

    expect(analyze(withDirectory(ALICE_DIR, dir))).toEqual({ ok: false, code: "invalid_structure" });
  });
});

describe("prepareRecoveryWrite: one write, built from what is stored now", () => {
  it("replaces only the damaged Directory, keeps its binding, and leaves everything else as stored (T5)", () => {
    const raw = withDirectory(BOB_DIR, { directoryId: "not-bob", junk: [1] }, inRecovery());
    const preview = previewFor(raw);

    const payload = prepareRecoveryWrite(raw, preview);

    expect(payload).toEqual({
      ok: true,
      value: {
        directories: { [ALICE_DIR]: preview.candidate.record, [BOB_DIR]: { directoryId: "not-bob", junk: [1] } },
        accountBindings: { [ALICE]: ALICE_DIR, [BOB]: BOB_DIR },
      },
    });
    expect(Object.keys(payload.ok ? payload.value : {})).toEqual(["directories", "accountBindings"]);
    const next = { ...raw, ...(payload.ok ? payload.value : {}) };
    expect(validateStorageHealth(next)).toMatchObject({ kind: "directory_error", directoryId: BOB_DIR });
    expect(migrateStorage({ ...next, directories: { [ALICE_DIR]: preview.candidate.record }, accountBindings: { [ALICE]: ALICE_DIR } }).directories[ALICE_DIR]).toEqual(preview.candidate.record);
  });

  it("binds an account with no Directory to the file's Directory", () => {
    const raw = withoutAlice();
    const preview = previewFor(raw);

    expect(prepareRecoveryWrite(raw, preview)).toEqual({
      ok: true,
      value: {
        directories: { [BOB_DIR]: (raw.directories as Record<string, unknown>)[BOB_DIR], [ALICE_DIR]: preview.candidate.record },
        accountBindings: { [BOB]: BOB_DIR, [ALICE]: ALICE_DIR },
      },
    });
  });

  it("drops this account's own empty Directory in the same write when the file's has another ID", () => {
    const raw = withDirectory("dir-new", directory("dir-new"), { ...withoutAlice(), accountBindings: { [ALICE]: "dir-new", [BOB]: BOB_DIR } });
    const preview = previewFor(raw);

    const payload = prepareRecoveryWrite(raw, preview);

    expect(payload.ok && Object.keys(payload.value.directories).sort()).toEqual([ALICE_DIR, BOB_DIR]);
    expect(payload.ok && payload.value.accountBindings).toEqual({ [ALICE]: ALICE_DIR, [BOB]: BOB_DIR });
  });

  it("keeps another account's newest data when only that account changed after the preview (A11)", () => {
    const raw = inRecovery();
    const preview = previewFor(raw);
    const bobLater = directory(BOB_DIR, { contacts: { c2: contact("c2", "dave", "400"), c3: contact("c3", "erin", "500") } });
    const now = withDirectory(BOB_DIR, bobLater, raw);

    const payload = prepareRecoveryWrite(now, preview);

    expect(payload.ok && payload.value.directories[BOB_DIR]).toEqual(bobLater);
  });

  it.each<[string, (raw: Record<string, unknown>) => Record<string, unknown>]>([
    ["its damaged Directory was edited", (raw) => withDirectory(ALICE_DIR, { ...damaged(), identityIndex: {} }, raw)],
    ["it was cleared", () => withoutAlice()],
    ["it was bound to another Directory", (raw) => ({ ...raw, directories: { ...(raw.directories as object), "dir-x": directory("dir-x") }, accountBindings: { [ALICE]: "dir-x", [BOB]: BOB_DIR } })],
  ])("refuses an old preview when this account's data changed since: %s (A11)", (_name, change) => {
    const raw = inRecovery();
    const preview = previewFor(raw);

    expect(prepareRecoveryWrite(change(raw), preview)).toEqual({ ok: false, code: "concurrent_change" });
  });

  it("refuses an empty target that gained a contact after the preview (A11)", () => {
    const raw = withoutAlice();
    const preview = previewFor(raw);
    const now = { ...raw, directories: { ...(raw.directories as object), "dir-new": directory("dir-new", { contacts: { c9: contact("c9", "erin", "900") } }) }, accountBindings: { [ALICE]: "dir-new", [BOB]: BOB_DIR } };

    expect(prepareRecoveryWrite(now, preview)).toEqual({ ok: false, code: "concurrent_change" });
  });

  it("accepts the same Directory stored again in another key order", () => {
    const raw = inRecovery();
    const preview = previewFor(raw);
    const now = withDirectory(ALICE_DIR, Object.fromEntries(Object.entries(damaged()).reverse()), raw);

    expect(prepareRecoveryWrite(now, preview)).toMatchObject({ ok: true });
  });

  it("refuses when the file's Directory ID was taken after the preview (A13)", () => {
    const raw = withoutAlice();
    const preview = previewFor(raw);
    const now = { ...raw, directories: { ...(raw.directories as object), [ALICE_DIR]: directory(ALICE_DIR) }, accountBindings: { [BOB]: ALICE_DIR } };

    expect(prepareRecoveryWrite(now, preview)).toEqual({ ok: false, code: "directory_id_occupied" });
  });

  it.each<[string, (preview: RecoveryPreview) => void]>([
    ["a nickname the app would never store", (p) => { p.candidate.record.contacts.c1.nickname = " "; }],
    ["an index that points at the wrong contact", (p) => { p.candidate.record.identityIndex["threads:999"] = "c1"; }],
    ["a record under another Directory ID", (p) => { p.candidate.record.directoryId = "dir-other"; }],
    ["a valid record that is not the file's", (p) => { p.candidate.record.contacts.c1.note = "Some other note"; }],
  ])("re-checks the candidate itself before any write: refuses %s", (_name, damage) => {
    const raw = inRecovery();
    const preview = previewFor(raw);
    damage(preview);

    expect(prepareRecoveryWrite(raw, preview)).toEqual({ ok: false, code: "invalid_records" });
  });
});

describe("prepareRecoveryWrite: the file's records are checked again too", () => {
  it("refuses records that no longer pass validation even when the candidate still matches them", () => {
    // An empty target compares nothing, so only the final record check stands between this and a write.
    const raw = withoutAlice();
    const preview = previewFor(raw);
    preview.source.contacts.c1.nickname = " ";
    preview.candidate.record.contacts.c1.nickname = " ";

    expect(prepareRecoveryWrite(raw, preview)).toEqual({ ok: false, code: "invalid_records" });
  });
});

describe("recoveryApplied: is this exact candidate what is stored?", () => {
  it("is true only for this account's binding and the whole candidate record", () => {
    const raw = inRecovery();
    const preview = previewFor(raw);
    const payload = prepareRecoveryWrite(raw, preview);
    if (!payload.ok) throw new Error(payload.code);
    const restored = { ...raw, ...payload.value };

    expect(recoveryApplied(restored, preview)).toBe(true);
    expect(recoveryApplied(raw, preview)).toBe(false);
    // Same Directory ID and the same counts are not enough: every value has to match.
    const edited = structuredClone(restored);
    (edited.directories as Record<string, { contacts: Record<string, { note?: string }> }>)[ALICE_DIR].contacts.c1.note = "Other";
    expect(recoveryApplied(edited, preview)).toBe(false);
    expect(recoveryApplied({ ...restored, accountBindings: { [BOB]: BOB_DIR } }, preview)).toBe(false);
    // An identical copy that the account is bound to under another key is not the restore either.
    const copy = structuredClone(restored) as { directories: Record<string, unknown>; accountBindings: Record<string, string> };
    copy.directories["dir-copy"] = copy.directories[ALICE_DIR];
    copy.accountBindings = { [ALICE]: "dir-copy", [BOB]: BOB_DIR };
    expect(recoveryApplied(copy, preview)).toBe(false);
    expect(recoveryApplied("PRIVATE_ROOT_PROBE", preview)).toBe(false);
  });
});

describe("the fixture", () => {
  it("is a Directory the loader sets aside, with the file's own records", () => {
    expect(validateStorageHealth(inRecovery())).toEqual({ kind: "directory_error", directoryId: ALICE_DIR, code: "DIRECTORY_INVALID" });
    expect(recoveryDirectory(recoveryImportFixture()).contacts).toEqual(damaged().contacts);
  });
});
