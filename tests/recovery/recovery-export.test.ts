import { afterEach, describe, expect, it, vi } from "vitest";

import { BACKUP_FORMAT } from "../../src/portability/backupTypes";
import { backupFilename, triggerBackupDownload } from "../../src/portability/exportBackup";
import { parseBackupText } from "../../src/portability/parseBackup";
import {
  CURRENT_RECOVERY_VERSION,
  RECOVERY_FORMAT,
  createRecoveryDump,
  recoveryDumpFilename,
  runRecoveryExport,
  serializeRecoveryDump,
} from "../../src/recovery/exportRecoveryDump";
import { PHASE_ONE_VERSION } from "../../src/shared/constants";
import { filesMatching } from "../fixtures/repoFiles";
import { installFakeChrome } from "../fixtures/storage/fakeChromeStorage";
import { ALICE, ALICE_DIR, AT, BOB, DAMAGED_ALICE, twoAccounts, withDirectory } from "../fixtures/storage/recoveryStorage";

vi.mock("../../src/portability/exportBackup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/portability/exportBackup")>()),
  triggerBackupDownload: vi.fn(),
}));

/**
 * The Recovery raw export (Phase 4 Task 20, checklist #16-#18). A dump is not a backup: a different format
 * tag the Backup importer refuses (Critical), holding only what was asked for, exactly as stored.
 */
const aliceDamaged = () => withDirectory(ALICE_DIR, DAMAGED_ALICE);
const dumpFor = (raw: unknown, owner: string | null) => createRecoveryDump({ raw, ownerThreadsUserId: owner, exportedAt: AT });

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
  vi.mocked(triggerBackupDownload).mockClear();
});

describe("createRecoveryDump: what is in it", () => {
  it("is tagged as a Recovery dump, with the version, the time, the extension version, the scope and the code", () => {
    const dump = dumpFor(aliceDamaged(), ALICE)!;

    expect(dump).toMatchObject({
      format: "your-name-for-threads-recovery",
      recoveryVersion: CURRENT_RECOVERY_VERSION,
      exportedAt: AT,
      extensionVersion: PHASE_ONE_VERSION,
      scope: "directory",
      code: "DIRECTORY_INVALID",
    });
    expect(dump.notice).toMatch(/private nicknames, notes and internal identifiers.*Do not post it publicly/);
  });

  it("holds, for one damaged Directory, that account's Directory and binding exactly as stored, and nothing of anyone else's", () => {
    const raw = aliceDamaged();
    const dump = dumpFor(raw, ALICE)!;
    const text = serializeRecoveryDump(dump);

    expect(dump.storage).toEqual({
      schemaVersion: 4,
      directories: { [ALICE_DIR]: DAMAGED_ALICE },
      accountBindings: { [ALICE]: ALICE_DIR },
    });
    // Not repaired, not normalized: the odd field and the wrong ID come through as they were.
    expect(text).toContain("PRIVATE_NICKNAME_PROBE");
    expect(text).toContain("not-the-key-it-is-stored-under");
    // Bob's contact, his Directory, his binding, the settings and the identity cache are not in it.
    expect(text).not.toMatch(/dave|"400"|dir-bob|"settings"|"identityCache"/);
    expect(text).not.toContain(BOB);
  });

  it("holds all of storage, verbatim, when the root is damaged and nothing can be scoped", () => {
    const raw = twoAccounts({ settings: 5 });
    const dump = dumpFor(raw, ALICE)!;

    expect(dump).toMatchObject({ scope: "global", code: "COLLECTION_INVALID" });
    expect(dump.storage).toEqual(raw);
    expect(serializeRecoveryDump(dump)).toContain("dave"); // every account's data, which the page has to say
  });

  it("is the same global dump for whoever asks, and for nobody signed in", () => {
    const raw = twoAccounts({ settings: 5 });

    expect(dumpFor(raw, BOB)!.storage).toEqual(raw);
    expect(dumpFor(raw, null)!.storage).toEqual(raw);
  });

  it.each([
    ["Bob, whose Directory is fine", aliceDamaged(), BOB],
    ["an account with no Directory yet", aliceDamaged(), "300"],
    ["nobody signed in, with only one Directory damaged", aliceDamaged(), null],
    ["healthy storage", twoAccounts(), ALICE],
    ["a fresh install", {}, ALICE],
  ])("is null for %s: there is nothing to export", (_name, raw, owner) => {
    expect(dumpFor(raw, owner)).toBeNull();
  });

  it("never changes what it reads", () => {
    const raw = aliceDamaged();
    const before = structuredClone(raw);

    dumpFor(raw, ALICE);

    expect(raw).toEqual(before);
  });
});

describe("createRecoveryDump: it is not a Backup", () => {
  const dumps = () => [dumpFor(aliceDamaged(), ALICE)!, dumpFor(twoAccounts({ settings: 5 }), ALICE)!];

  it("has a format tag of its own", () => {
    expect(RECOVERY_FORMAT).toBe("your-name-for-threads-recovery");
    expect(RECOVERY_FORMAT).not.toBe(BACKUP_FORMAT);
  });

  it("is refused by the Backup importer as not a backup, whichever scope it has (Critical)", () => {
    for (const dump of dumps()) {
      const result = parseBackupText(serializeRecoveryDump(dump));

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("invalid_format");
    }
  });

  it("is still refused when someone makes it look more like a backup", () => {
    for (const dump of dumps()) {
      const dressedUp = JSON.stringify({ ...dump, backupVersion: 2, contacts: [], tombstones: [], directoryId: "x", exportedBy: { threadsUserId: "1", username: "a" } });

      const result = parseBackupText(dressedUp);

      expect(result.ok).toBe(false);
      // Stopped at the format tag, the first check, not by luck further down on the fields it lacks.
      if (!result.ok) expect(result.error.code).toBe("invalid_format");
    }
  });

  it("is read back only by the recovery reader: no other source file knows the format", () => {
    // 1.1.0 added one reader, `recoveryImport.ts`, which holds a single-account file to its own checks and restores it
    // only into an empty Directory or the damaged one it came from; the Backup importer still refuses it (above). A new
    // file that mentions the format has to be added here on purpose, after asking whether it has just made a Recovery
    // dump importable some other way.
    expect(filesMatching(/your-name-for-threads-recovery|RECOVERY_FORMAT/)).toEqual(["src/recovery/exportRecoveryDump.ts", "src/recovery/recoveryImport.ts"]);
  });

  it("does not use the backup's filename", () => {
    expect(recoveryDumpFilename("2026-09-16T13:45:00.000Z")).toBe("your-name-for-threads-recovery-2026-09-16T134500Z.json");
    expect(recoveryDumpFilename("2026-09-16T13:45:00.000Z")).not.toBe(backupFilename("2026-09-16T13:45:00.000Z"));
  });
});

describe("runRecoveryExport", () => {
  it("saves the account's dump to a file, and changes nothing in storage", async () => {
    const area = installFakeChrome(aliceDamaged());
    const before = area.snapshot();

    await expect(runRecoveryExport(ALICE, () => AT)).resolves.toBe(true);

    expect(triggerBackupDownload).toHaveBeenCalledTimes(1);
    const [filename, json] = vi.mocked(triggerBackupDownload).mock.calls[0];
    expect(filename).toBe("your-name-for-threads-recovery-2026-03-01T000000Z.json");
    expect(JSON.parse(json)).toMatchObject({ format: RECOVERY_FORMAT, scope: "directory", storage: { directories: { [ALICE_DIR]: DAMAGED_ALICE } } });
    expect(area.writeCount()).toBe(0);
    expect(area.snapshot()).toEqual(before);
  });

  it("exports nothing for an account that is not in Recovery", async () => {
    installFakeChrome(aliceDamaged());

    await expect(runRecoveryExport(BOB)).resolves.toBe(false);

    expect(triggerBackupDownload).not.toHaveBeenCalled();
  });

  it("does not throw when storage cannot be read, and exports nothing", async () => {
    installFakeChrome(aliceDamaged());
    chrome.storage.local.get = () => Promise.reject(new Error("storage is unavailable"));

    await expect(runRecoveryExport(ALICE)).resolves.toBe(false);

    expect(triggerBackupDownload).not.toHaveBeenCalled();
  });

  it("does not throw when the download itself fails", async () => {
    installFakeChrome(aliceDamaged());
    vi.mocked(triggerBackupDownload).mockImplementationOnce(() => {
      throw new Error("blocked");
    });

    await expect(runRecoveryExport(ALICE)).resolves.toBe(false);
  });
});
