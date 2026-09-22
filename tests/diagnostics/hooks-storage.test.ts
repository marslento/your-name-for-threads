import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { reportDiagnostic } from "../../src/diagnostics/reportDiagnostic";
import { __resetMigrationCoordinatorForTests, loadAndMigrateStorage, performMigrationOnce } from "../../src/storage/migrations";
import { installFakeChrome } from "../fixtures/storage/fakeChromeStorage";
import { migrationCoordinatorSendMessage } from "../fixtures/storage/migrationCoordinator";

vi.mock("../../src/diagnostics/reportDiagnostic", () => ({ reportDiagnostic: vi.fn() }));

const OWNER = "17841400000000000";
const SETTINGS = { enabled: true, nicknameDisplay: { profile: true, feed: true, replies: true, quotes: true } };

const healthyV4 = () => ({
  schemaVersion: 4,
  directories: { "dir-1": { directoryId: "dir-1", contacts: {}, tombstones: {}, identityIndex: {}, identityConflicts: {} } },
  accountBindings: { [OWNER]: "dir-1" },
  identityCache: {},
  settings: SETTINGS,
});

/** A binding to a Directory that does not exist: current version, content that no longer validates. */
const invalidV4 = () => ({ ...healthyV4(), accountBindings: { [OWNER]: "dir-that-is-gone" } });

const legacyV2 = () => ({
  schemaVersion: 2,
  contacts: {},
  tombstones: {},
  identityIndex: {},
  identityCache: {},
  identityConflicts: {},
  settings: SETTINGS,
});

beforeEach(() => {
  vi.mocked(reportDiagnostic).mockClear();
  __resetMigrationCoordinatorForTests();
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
});

describe("storage -> STORAGE_VALIDATION_FAILED", () => {
  it("is reported when current-version storage no longer validates, and the failure still propagates", async () => {
    installFakeChrome(invalidV4(), migrationCoordinatorSendMessage());

    await expect(loadAndMigrateStorage()).rejects.toThrow();

    expect(reportDiagnostic).toHaveBeenCalledTimes(1);
    expect(reportDiagnostic).toHaveBeenCalledWith("STORAGE_VALIDATION_FAILED", "storage");
    expect(JSON.stringify(vi.mocked(reportDiagnostic).mock.calls)).not.toMatch(new RegExp(`${OWNER}|dir-`));
  });

  it("is reported from the migration path's own already-current read too", async () => {
    installFakeChrome(invalidV4());

    await expect(performMigrationOnce()).rejects.toThrow();

    expect(reportDiagnostic).toHaveBeenCalledWith("STORAGE_VALIDATION_FAILED", "storage");
    expect(reportDiagnostic).not.toHaveBeenCalledWith("STORAGE_MIGRATION_FAILED", "storage");
  });

  it("is not reported for healthy storage", async () => {
    installFakeChrome(healthyV4(), migrationCoordinatorSendMessage());

    await loadAndMigrateStorage();

    expect(reportDiagnostic).not.toHaveBeenCalled();
  });

  it("is reported when storage turns invalid between the migration finishing and the re-read that follows it", async () => {
    // The coordinator says "done", but a sibling context has since written something that does not validate.
    const storage = installFakeChrome(legacyV2(), async () => {
      await storage.set(invalidV4());
      return { ok: true };
    });

    await expect(loadAndMigrateStorage()).rejects.toThrow();

    expect(reportDiagnostic).toHaveBeenCalledWith("STORAGE_VALIDATION_FAILED", "storage");
  });

  it("does not modify the storage it could not validate (Phase 4 §17: recording must not touch broken data)", async () => {
    const storage = installFakeChrome(invalidV4(), migrationCoordinatorSendMessage());
    const before = storage.snapshot();

    await expect(loadAndMigrateStorage()).rejects.toThrow();

    expect(storage.snapshot()).toEqual(before);
    expect(storage.writeCount()).toBe(0);
  });
});

describe("storage -> STORAGE_MIGRATION_FAILED", () => {
  it("is reported when an older schema cannot be migrated (unsupported version)", async () => {
    installFakeChrome({ schemaVersion: 99 }, migrationCoordinatorSendMessage());

    await expect(loadAndMigrateStorage()).rejects.toThrow();

    expect(reportDiagnostic).toHaveBeenCalledWith("STORAGE_MIGRATION_FAILED", "storage");
    expect(reportDiagnostic).not.toHaveBeenCalledWith("STORAGE_VALIDATION_FAILED", "storage");
  });

  it("is reported when writing the migrated storage fails", async () => {
    const storage = installFakeChrome(legacyV2(), migrationCoordinatorSendMessage());
    storage.set = () => Promise.reject(new Error("quota"));

    await expect(loadAndMigrateStorage()).rejects.toThrow();

    expect(reportDiagnostic).toHaveBeenCalledWith("STORAGE_MIGRATION_FAILED", "storage");
  });

  it("is reported when the legacy data is itself malformed", async () => {
    installFakeChrome({ ...legacyV2(), contacts: "not a collection" }, migrationCoordinatorSendMessage());

    await expect(loadAndMigrateStorage()).rejects.toThrow();

    expect(reportDiagnostic).toHaveBeenCalledWith("STORAGE_MIGRATION_FAILED", "storage");
  });

  it("is not reported for a migration that succeeds", async () => {
    installFakeChrome(legacyV2(), migrationCoordinatorSendMessage());

    await loadAndMigrateStorage();

    expect(reportDiagnostic).not.toHaveBeenCalled();
  });

  it("is not reported for a fresh install with nothing stored", async () => {
    installFakeChrome({}, migrationCoordinatorSendMessage());

    await loadAndMigrateStorage();

    expect(reportDiagnostic).not.toHaveBeenCalled();
  });
});
