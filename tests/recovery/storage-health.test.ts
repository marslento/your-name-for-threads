import { describe, expect, it } from "vitest";

import { RECOVERY_CODES, type RecoveryCode } from "../../src/recovery/recoveryTypes";
import { invalidDirectoryIds, validateStorageHealth, type StorageHealth } from "../../src/recovery/validateStorageHealth";
import { migrateStorage } from "../../src/storage/migrations";
import { ALICE_DIR, AT, contact, directory, twoAccounts, withDirectory } from "../fixtures/storage/recoveryStorage";
import { v1ActiveAndDeletedFixture } from "../fixtures/storage/v1-active-and-deleted";

/**
 * The health classifier (Phase 4 Task 16). What it must get right is the direction of every error: it must
 * never call damaged data healthy, and never healthy data damaged, and it may narrow damage to one
 * Directory only when that is actually true. It is also checked against the real loader, since "healthy"
 * means "the loader accepts it".
 */
const global = (code: RecoveryCode): StorageHealth => ({ kind: "global_error", code });
const damaged = (directoryId: string): StorageHealth => ({ kind: "directory_error", directoryId, code: "DIRECTORY_INVALID" });

const loaderAccepts = (raw: unknown) => {
  try {
    migrateStorage(raw);
    return true;
  } catch {
    return false;
  }
};

describe("validateStorageHealth: healthy", () => {
  it.each([
    ["a fresh install with nothing stored", {}],
    ["current data with two accounts", twoAccounts()],
    ["current data with no accounts yet", { schemaVersion: 4, directories: {}, accountBindings: {} }],
    ["legacy V1 data that migrates", v1ActiveAndDeletedFixture],
    ["an unversioned V1 shape that migrates", { contacts: {}, identityIndex: {}, identityCache: {}, identityConflicts: {} }],
  ])("%s", (_name, raw) => {
    expect(validateStorageHealth(raw)).toEqual({ kind: "healthy" });
    expect(loaderAccepts(raw)).toBe(true);
  });
});

describe("validateStorageHealth: one damaged Directory", () => {
  it("names Alice's Directory when its ID does not match the key it is stored under", () => {
    const raw = withDirectory("dir-alice", directory("some-other-id"));

    expect(validateStorageHealth(raw)).toEqual(damaged("dir-alice"));
    expect(invalidDirectoryIds(raw)).toEqual(["dir-alice"]);
  });

  it.each([
    ["is not an object", "junk"],
    ["is null", null],
    ["is an array", []],
    ["has a merged tombstone with no merge target", directory("dir-alice", { tombstones: { t: { contactId: "t", username: "x", createdAt: AT, deletedAt: AT, reason: "merged" } } })],
  ])("a Directory whose record %s is that Directory's problem alone", (_name, value) => {
    const raw = withDirectory("dir-alice", value);

    expect(validateStorageHealth(raw)).toEqual(damaged("dir-alice"));
    // Bob's Directory, on its own, is fine: nothing about Alice's damage changes that.
    expect(invalidDirectoryIds(raw)).not.toContain("dir-bob");
  });

  it("does not blame the healthy account, and still blames the damaged one, whichever is stored first", () => {
    const bobFirst = { ...twoAccounts(), directories: { "dir-bob": directory("dir-bob"), "dir-alice": directory("wrong") } };

    expect(validateStorageHealth(bobFirst)).toEqual(damaged("dir-alice"));
  });

  it("a binding that points at a damaged Directory is still a directory problem, not a global one", () => {
    // Alice is bound to dir-alice, which is damaged. The binding itself is well formed.
    expect(validateStorageHealth(withDirectory("dir-alice", "junk"))).toEqual(damaged("dir-alice"));
  });

  it("with two damaged Directories, names the first in a stable order and lists both for the caller that has to decide per account", () => {
    const raw = withDirectory("dir-bob", "junk", withDirectory("dir-alice", "junk"));
    const reversed = { ...raw, directories: Object.fromEntries(Object.entries(raw.directories as Record<string, unknown>).reverse()) };

    expect(validateStorageHealth(raw)).toEqual(damaged("dir-alice"));
    expect(validateStorageHealth(reversed)).toEqual(damaged("dir-alice"));
    expect(invalidDirectoryIds(raw)).toEqual(["dir-alice", "dir-bob"]);
    expect(invalidDirectoryIds(reversed)).toEqual(["dir-alice", "dir-bob"]);
  });

  it("is global, not directory-scoped, when something else is wrong as well", () => {
    // Removing Alice's Directory would not make this load: the settings are damaged too.
    expect(validateStorageHealth(withDirectory("dir-alice", "junk", twoAccounts({ settings: 5 })))).toEqual(global("COLLECTION_INVALID"));
    // Nor would it if an unrelated binding is broken.
    const brokenBinding = withDirectory("dir-alice", "junk", twoAccounts({ accountBindings: { "100": "dir-alice", "200": "dir-bob", "300": "dir-gone" } }));
    expect(validateStorageHealth(brokenBinding)).toEqual(global("BINDINGS_INVALID"));
  });
});

/**
 * What a Directory holds (Phase 4 follow-up to Task 24, review checklist 11 and the Critical "corrupts or
 * auto-repairs user data silently"). The loader used to read a collection that was not a record as `{}` and
 * to accept any contact at all, so a Directory whose contacts were garbage looked empty and healthy - and the
 * next write would have replaced the garbage with an empty collection. Present-but-wrong is damage now.
 * What is absent is still empty, and fields the loader has never heard of are left alone.
 */
describe("validateStorageHealth: what a Directory holds", () => {
  const holding = (patch: Record<string, unknown>) => withDirectory(ALICE_DIR, { ...directory(ALICE_DIR), ...patch });
  const good = () => contact("c1", "carol", "300");
  const withContact = (patch: Record<string, unknown>) => holding({ contacts: { c1: { ...good(), ...patch } }, identityIndex: { "username:carol": "c1" } });
  const withoutField = (field: string) => {
    const { [field]: _dropped, ...rest } = good() as Record<string, unknown>;
    return holding({ contacts: { c1: rest } });
  };

  it("(control) is healthy with a complete contact, a tombstone, an index and a conflict, and with nothing but its ID", () => {
    const full = holding({
      contacts: { c1: good() },
      tombstones: { t1: { contactId: "t1", username: "gone", createdAt: AT, deletedAt: AT, reason: "deleted" } },
      identityIndex: { "username:carol": "c1", "threads:300": "c1" },
      identityConflicts: { k1: { id: "k1", threadsUserId: "300", contactIds: ["c1"], detectedAt: AT } },
    });

    expect(validateStorageHealth(full)).toEqual({ kind: "healthy" });
    expect(validateStorageHealth(withDirectory(ALICE_DIR, { directoryId: ALICE_DIR }))).toEqual({ kind: "healthy" });
    expect(validateStorageHealth(holding({ contacts: undefined, identityIndex: undefined }))).toEqual({ kind: "healthy" });
  });

  describe.each(["contacts", "tombstones", "identityIndex", "identityConflicts"])("a %s that is present but is not a record", (name) => {
    it.each([["a string", "oops"], ["a number", 7], ["an array", ["a"]], ["null", null]])("is %s: that Directory is damaged, and empty is not what it is read as", (_kind, value) => {
      const raw = holding({ [name]: value });

      expect(validateStorageHealth(raw)).toEqual(damaged(ALICE_DIR));
      expect(loaderAccepts(raw)).toBe(false);
      expect(invalidDirectoryIds(raw)).toEqual([ALICE_DIR]);
    });
  });

  it.each(["id", "username", "nickname", "createdAt", "updatedAt", "identityUpdatedAt"])("a contact with no %s is damaged", (field) => {
    expect(validateStorageHealth(withoutField(field))).toEqual(damaged(ALICE_DIR));
  });

  it.each(["id", "username", "nickname", "createdAt", "updatedAt", "identityUpdatedAt", "threadsUserId", "note"])("a contact whose %s is a number is damaged", (field) => {
    expect(validateStorageHealth(withContact({ [field]: 5 }))).toEqual(damaged(ALICE_DIR));
  });

  it.each([["a string", "x"], ["null", null], ["an array", []], ["a number", 7]])("a contact that is %s is damaged", (_kind, value) => {
    expect(validateStorageHealth(holding({ contacts: { c1: value } }))).toEqual(damaged(ALICE_DIR));
  });

  it("does not mind a contact's optional fields being absent or explicitly undefined, or fields it has not heard of", () => {
    expect(validateStorageHealth(withContact({ threadsUserId: undefined, note: undefined }))).toEqual({ kind: "healthy" });
    expect(validateStorageHealth(withContact({ futureField: { anything: [1, 2, 3] } }))).toEqual({ kind: "healthy" });
    expect(validateStorageHealth(withoutField("threadsUserId"))).toEqual({ kind: "healthy" });
  });

  it.each([["a number", 7], ["null", null], ["an object", {}]])("an index entry that is %s is damaged", (_kind, value) => {
    expect(validateStorageHealth(holding({ identityIndex: { "username:carol": value } }))).toEqual(damaged(ALICE_DIR));
  });

  it.each([["a string", "x"], ["null", null], ["an array", []]])("a conflict that is %s is damaged", (_kind, value) => {
    expect(validateStorageHealth(holding({ identityConflicts: { k1: value } }))).toEqual(damaged(ALICE_DIR));
  });

  it.each([["a string", "x"], ["null", null], ["a number", 7], ["an array", []]])("a tombstone that is %s is damaged", (_kind, value) => {
    expect(validateStorageHealth(holding({ tombstones: { t1: value } }))).toEqual(damaged(ALICE_DIR));
  });

  it("leaves the healthy account alone, so one account's garbage stops only that account", () => {
    const raw = holding({ contacts: "oops" });

    expect(invalidDirectoryIds(raw)).toEqual([ALICE_DIR]);
    expect(validateStorageHealth(raw)).toEqual(damaged(ALICE_DIR));
  });
});

describe("validateStorageHealth: the root, the bindings and the schema", () => {
  it.each([
    ["null", null, "STORAGE_ROOT_INVALID"],
    ["undefined", undefined, "STORAGE_ROOT_INVALID"],
    ["a string", "storage", "STORAGE_ROOT_INVALID"],
    ["a number", 4, "STORAGE_ROOT_INVALID"],
    ["an array", [], "STORAGE_ROOT_INVALID"],
  ] as const)("storage that is %s", (_name, raw, code) => {
    expect(validateStorageHealth(raw)).toEqual(global(code));
  });

  it.each([
    ["a string", "4", "SCHEMA_VERSION_INVALID"],
    ["a fraction", 3.5, "SCHEMA_VERSION_INVALID"],
    ["null", null, "SCHEMA_VERSION_INVALID"],
    ["a version from the future", 5, "SCHEMA_VERSION_UNSUPPORTED"],
    ["zero", 0, "SCHEMA_VERSION_UNSUPPORTED"],
    ["negative", -1, "SCHEMA_VERSION_UNSUPPORTED"],
  ] as const)("a schema version that is %s", (_name, schemaVersion, code) => {
    expect(validateStorageHealth({ ...twoAccounts(), schemaVersion })).toEqual(global(code));
  });

  it.each(["directories", "accountBindings", "identityCache", "settings"])("a %s that is not an object", (key) => {
    for (const value of ["x", 5, [], null]) {
      expect(validateStorageHealth(twoAccounts({ [key]: value })), `${key} = ${JSON.stringify(value)}`).toEqual(global("COLLECTION_INVALID"));
    }
  });

  it.each([
    ["an owner key that is not a Threads user ID", { alice: "dir-alice" }],
    ["a target that is not a string", { "100": 7 }],
    ["an empty target", { "100": "" }],
    ["a target that names no Directory", { "100": "dir-gone" }],
    ["one Directory bound to two accounts", { "100": "dir-alice", "200": "dir-alice" }],
  ])("bindings with %s", (_name, accountBindings) => {
    expect(validateStorageHealth(twoAccounts({ accountBindings }))).toEqual(global("BINDINGS_INVALID"));
  });

  it.each([
    ["version 3 with no Directory metadata", { schemaVersion: 3, contacts: {}, tombstones: {}, identityIndex: {}, identityCache: {}, identityConflicts: {} }],
    ["version 2 with a merged tombstone and no merge target", { schemaVersion: 2, contacts: {}, tombstones: { t: { contactId: "t", username: "x", createdAt: AT, deletedAt: AT, reason: "merged" } }, identityIndex: {}, identityCache: {}, identityConflicts: {} }],
    ["version 1 with a collection that is not an object", { schemaVersion: 1, contacts: [], identityIndex: {}, identityCache: {}, identityConflicts: {} }],
    ["an unversioned shape with a collection that is not an object", { contacts: 5 }],
  ])("legacy data that cannot be migrated: %s", (_name, raw) => {
    expect(validateStorageHealth(raw)).toEqual(global("MIGRATION_FAILED"));
  });
});

describe("validateStorageHealth: it only reads, and it does not throw", () => {
  const damagedInputs = [twoAccounts({ accountBindings: { "100": "dir-gone" } }), withDirectory("dir-alice", "junk"), twoAccounts({ settings: 5 }), { schemaVersion: 9 }, { contacts: 5 }];

  const deepFreeze = <T>(value: T): T => {
    if (typeof value === "object" && value !== null) {
      Object.freeze(value);
      for (const inner of Object.values(value)) deepFreeze(inner);
    }
    return value;
  };

  it("leaves what it inspects exactly as it found it (nothing is repaired, skipped or marked)", () => {
    for (const raw of [twoAccounts(), ...damagedInputs]) {
      const before = structuredClone(raw);
      const live = structuredClone(raw);
      // Frozen, a write to it throws. The function swallows that and fails closed, so compare the answer as well as the data.
      const frozen = deepFreeze(structuredClone(raw));

      expect(validateStorageHealth(frozen)).toEqual(validateStorageHealth(live));
      expect(invalidDirectoryIds(frozen)).toEqual(invalidDirectoryIds(live));
      expect(live).toEqual(before);
      expect(frozen).toEqual(before);
    }
  });

  it("never throws, whatever it is given", () => {
    const strange: unknown[] = [undefined, null, 0, "", NaN, [], [[]], () => 1, Symbol("s"), new Date(), { schemaVersion: {} }, { schemaVersion: 4, directories: { a: undefined } }, Object.create(null)];

    for (const raw of strange) expect(() => validateStorageHealth(raw)).not.toThrow();
  });

  it("fails closed, at the widest scope, on data that throws when it is read", () => {
    const poison = Object.defineProperty({ schemaVersion: 4 }, "directories", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });

    expect(validateStorageHealth(poison)).toEqual(global("STORAGE_INVALID"));
  });

  it("agrees with the real loader on every input: healthy exactly when the loader accepts it", () => {
    const corpus: unknown[] = [{}, twoAccounts(), v1ActiveAndDeletedFixture, ...damagedInputs, null, "x", { schemaVersion: 4 }, withDirectory("dir-bob", directory("dir-bob"))];

    for (const raw of corpus) {
      expect(validateStorageHealth(raw).kind === "healthy", JSON.stringify(raw)?.slice(0, 80)).toBe(loaderAccepts(raw));
    }
  });
});

describe("recovery codes", () => {
  it("only ever reports a code from the closed list, at the scope the code belongs to", () => {
    const seen = [twoAccounts(), withDirectory("dir-alice", "junk"), twoAccounts({ settings: 5 }), null, { schemaVersion: 5 }, { contacts: 5 }]
      .map(validateStorageHealth)
      .filter((health): health is Exclude<StorageHealth, { kind: "healthy" }> => health.kind !== "healthy");

    expect(seen.length).toBeGreaterThan(0);
    for (const health of seen) {
      expect(RECOVERY_CODES).toContain(health.code);
      expect(health.kind === "directory_error").toBe(health.code === "DIRECTORY_INVALID");
    }
  });

  it("carries no stored text: a damaged Directory's contents never appear in the result", () => {
    const raw = withDirectory("dir-alice", { directoryId: "wrong", contacts: { c: { nickname: "PRIVATE_NICKNAME_PROBE", note: "PRIVATE_NOTE_PROBE" } } });

    const result = validateStorageHealth(raw);

    expect(result.kind).toBe("directory_error");
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_/);
  });
});
