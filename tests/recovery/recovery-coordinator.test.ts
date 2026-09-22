import { afterEach, describe, expect, it } from "vitest";

import { readRecoveryState, recoveryStateFor } from "../../src/recovery/RecoveryCoordinator";
import type { RecoveryState } from "../../src/recovery/recoveryTypes";
import { installFakeChrome } from "../fixtures/storage/fakeChromeStorage";
import { ALICE, ALICE_DIR, BOB, BOB_DIR, DAMAGED_ALICE, directory, twoAccounts, withDirectory } from "../fixtures/storage/recoveryStorage";

/**
 * The Recovery coordinator (Phase 4 Task 17). The two things it must get right are the scope and the
 * silence: damage to one account's Directory blocks that account and nobody else, damage to the root
 * blocks everyone, and deciding any of it writes nothing at all.
 */
const NONE: RecoveryState = { kind: "none" };
const DIRECTORY: RecoveryState = { kind: "directory", code: "DIRECTORY_INVALID" };
const UNBOUND = "300";

const aliceDamaged = () => withDirectory(ALICE_DIR, DAMAGED_ALICE);

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
});

describe("recoveryStateFor: nothing is wrong", () => {
  it.each([
    ["Alice", ALICE],
    ["Bob", BOB],
    ["an account with no Directory yet", UNBOUND],
    ["nobody signed in", null],
  ])("%s is not in Recovery", (_name, owner) => {
    expect(recoveryStateFor(twoAccounts(), owner)).toEqual(NONE);
  });

  it("treats a fresh install as healthy", () => {
    expect(recoveryStateFor({}, ALICE)).toEqual(NONE);
  });
});

describe("recoveryStateFor: Alice's Directory is damaged and Bob's is healthy", () => {
  it("puts Alice, and only Alice, in directory Recovery", () => {
    expect(recoveryStateFor(aliceDamaged(), ALICE)).toEqual(DIRECTORY);
    expect(recoveryStateFor(aliceDamaged(), BOB)).toEqual(NONE);
    expect(recoveryStateFor(aliceDamaged(), UNBOUND)).toEqual(NONE);
    expect(recoveryStateFor(aliceDamaged(), null)).toEqual(NONE);
  });

  it("puts both in directory Recovery when both Directories are damaged, not just the one the classifier names first", () => {
    const both = withDirectory(BOB_DIR, "junk", aliceDamaged());

    expect(recoveryStateFor(both, ALICE)).toEqual(DIRECTORY);
    expect(recoveryStateFor(both, BOB)).toEqual(DIRECTORY);
    expect(recoveryStateFor(both, UNBOUND)).toEqual(NONE);
  });

  it("blames no account for a damaged Directory nobody is bound to", () => {
    const orphan = withDirectory("dir-orphan", "junk");

    expect(recoveryStateFor(orphan, ALICE)).toEqual(NONE);
    expect(recoveryStateFor(orphan, BOB)).toEqual(NONE);
  });

  it("does not take a string that is not an account ID for one", () => {
    expect(recoveryStateFor(aliceDamaged(), "alice")).toEqual(NONE);
    expect(recoveryStateFor(aliceDamaged(), "")).toEqual(NONE);
  });
});

describe("recoveryStateFor: the root is damaged", () => {
  it.each([
    ["a setting that is not an object", twoAccounts({ settings: 5 }), "COLLECTION_INVALID"],
    ["a binding to a Directory that is not there", twoAccounts({ accountBindings: { [ALICE]: "dir-gone", [BOB]: BOB_DIR } }), "BINDINGS_INVALID"],
    ["a schema version from the future", twoAccounts({ schemaVersion: 9 }), "SCHEMA_VERSION_UNSUPPORTED"],
    ["storage that is not an object", null, "STORAGE_ROOT_INVALID"],
    ["an old layout that cannot be migrated", { contacts: 5 }, "MIGRATION_FAILED"],
  ] as const)("%s pauses every account, and nobody signed in", (_name, raw, code) => {
    for (const owner of [ALICE, BOB, UNBOUND, null]) {
      expect(recoveryStateFor(raw, owner), String(owner)).toEqual({ kind: "global", code });
    }
  });

  it("is global for everyone when a Directory is damaged as well, not only for the damaged account", () => {
    const both = withDirectory(ALICE_DIR, DAMAGED_ALICE, twoAccounts({ settings: 5 }));

    expect(recoveryStateFor(both, ALICE)).toEqual({ kind: "global", code: "COLLECTION_INVALID" });
    expect(recoveryStateFor(both, BOB)).toEqual({ kind: "global", code: "COLLECTION_INVALID" });
  });
});

describe("recoveryStateFor: it only reads", () => {
  const deepFreeze = <T>(value: T): T => {
    if (typeof value === "object" && value !== null) {
      Object.freeze(value);
      for (const inner of Object.values(value)) deepFreeze(inner);
    }
    return value;
  };

  it("leaves what it inspects exactly as it found it, and answers the same for it frozen", () => {
    for (const raw of [twoAccounts(), aliceDamaged(), twoAccounts({ settings: 5 })]) {
      const before = structuredClone(raw);
      const frozen = deepFreeze(structuredClone(raw));

      for (const owner of [ALICE, BOB, null]) expect(recoveryStateFor(frozen, owner)).toEqual(recoveryStateFor(structuredClone(raw), owner));
      expect(frozen).toEqual(before);
    }
  });

  it("carries none of the damaged Directory's contents in what it returns", () => {
    const result = JSON.stringify([ALICE, BOB, null].map((owner) => recoveryStateFor(aliceDamaged(), owner)));

    expect(result).not.toMatch(/PRIVATE_|dir-alice|not-the-key/);
  });
});

describe("readRecoveryState", () => {
  it("reads storage once and decides from it, without writing anything", async () => {
    const area = installFakeChrome(aliceDamaged());
    const before = area.snapshot();

    await expect(readRecoveryState(ALICE)).resolves.toEqual(DIRECTORY);
    await expect(readRecoveryState(BOB)).resolves.toEqual(NONE);

    expect(area.writeCount()).toBe(0);
    expect(area.snapshot()).toEqual(before);
    // Positive control: the damaged payload really is what it looked at, and it is still there, unmarked.
    expect((area.snapshot().directories as Record<string, unknown>)[ALICE_DIR]).toEqual(DAMAGED_ALICE);
  });

  it("does not turn a failure to read storage into a Recovery state, or into a healthy one", async () => {
    installFakeChrome(twoAccounts());
    const failure = new Error("storage is unavailable");
    chrome.storage.local.get = () => Promise.reject(failure);

    await expect(readRecoveryState(ALICE)).rejects.toBe(failure);
  });

  it("says nothing is wrong for healthy storage", async () => {
    installFakeChrome(twoAccounts({ directories: { [ALICE_DIR]: directory(ALICE_DIR), [BOB_DIR]: directory(BOB_DIR) } }));

    await expect(readRecoveryState(ALICE)).resolves.toEqual(NONE);
  });
});
