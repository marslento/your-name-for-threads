import { afterEach, describe, expect, it } from "vitest";

import { validateStorageHealth } from "../../src/recovery/validateStorageHealth";
import { BrowserStorageContactsRepository } from "../../src/storage/BrowserStorageContactsRepository";
import { __resetMigrationCoordinatorForTests } from "../../src/storage/migrations";
import { installFakeChrome } from "../fixtures/storage/fakeChromeStorage";
import { ALICE, ALICE_DIR, AT, BOB, contact, directory, withDirectory } from "../fixtures/storage/recoveryStorage";

afterEach(() => {
  __resetMigrationCoordinatorForTests();
  Reflect.deleteProperty(globalThis, "chrome");
});

describe("damaged identity metadata fails closed for its own Directory", () => {
  const good = contact("c1", "carol", "300");
  const conflict = { id: "k1", threadsUserId: "300", contactIds: ["c1"], detectedAt: AT };
  const cases: Array<[string, Record<string, unknown>]> = [
    ["numeric identity points at a different person", { identityIndex: { "threads:400": "c1" } }],
    ["username points at a different person", { identityIndex: { "username:dave": "c1" } }],
    ["index points at a missing contact", { identityIndex: { "threads:300": "missing" } }],
    ["unknown index key", { identityIndex: { "other:carol": "c1" } }],
    ["contact stored under the wrong id", { contacts: { c1: { ...good, id: "another" } } }],
    ["conflict is empty", { identityConflicts: { k1: {} } }],
    ["conflict has no contactIds", { identityConflicts: { k1: { ...conflict, contactIds: undefined } } }],
    ["conflict contactIds is a string", { identityConflicts: { k1: { ...conflict, contactIds: "c1" } } }],
    ["conflict member is not an id", { identityConflicts: { k1: { ...conflict, contactIds: [1] } } }],
    ["conflict id differs from its key", { identityConflicts: { k1: { ...conflict, id: "other" } } }],
    ["conflict has no numeric identity", { identityConflicts: { k1: { ...conflict, threadsUserId: undefined } } }],
    ["conflict has no date", { identityConflicts: { k1: { ...conflict, detectedAt: undefined } } }],
  ];

  it.each(cases)("%s: refuses Alice, preserves the raw payload and lets Bob write", async (_name, patch) => {
    const damaged = directory(ALICE_DIR, { contacts: { c1: good }, ...patch });
    const raw = withDirectory(ALICE_DIR, damaged);
    const area = installFakeChrome(raw);
    const repository = new BrowserStorageContactsRepository();

    expect(validateStorageHealth(raw)).toEqual({ kind: "directory_error", directoryId: ALICE_DIR, code: "DIRECTORY_INVALID" });
    await expect(repository.getByIdentity(ALICE, { username: "dave", threadsUserId: "400" })).rejects.toThrow();
    expect(area.snapshot()).toEqual(raw);
    await repository.upsertNickname(BOB, { identity: { username: "erin", threadsUserId: "500" }, nickname: "Demo", now: AT });
    expect((area.snapshot().directories as Record<string, unknown>)[ALICE_DIR]).toEqual(damaged);
    expect((area.snapshot().accountBindings as Record<string, unknown>)[ALICE]).toBe(ALICE_DIR);
  });
});
