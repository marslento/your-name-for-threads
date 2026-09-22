import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetDiagnosticReportsForTests } from "../../src/diagnostics/reportDiagnostic";
import { __resetMigrationCoordinatorForTests, loadAndMigrateStorage } from "../../src/storage/migrations";
import { backgroundSendMessage } from "../fixtures/storage/diagnosticCoordinator";
import { installFakeChrome } from "../fixtures/storage/fakeChromeStorage";

/**
 * Phase 4 §17 and review of Tasks 3-9, note on the fake storage: recording a
 * storage failure must not touch the storage it reports on. tests/diagnostics/
 * hooks-storage.test.ts checks that the right code is reported, but it mocks the
 * reporter out, so it cannot show what the REAL reporter, through the REAL
 * coordinator, writes. This does: no mock anywhere, the payload compared whole
 * and byte for byte, and every key that was ever written recorded.
 */
const OWNER = "17841400000000000";
const SETTINGS = { enabled: true, nicknameDisplay: { profile: true, feed: true, replies: true, quotes: true } };

const invalidV4 = () => ({
  schemaVersion: 4,
  directories: { "dir-1": { directoryId: "dir-1", contacts: { c1: { id: "c1", username: "alice", nickname: "Nick" } }, tombstones: {}, identityIndex: {}, identityConflicts: {} } },
  accountBindings: { [OWNER]: "dir-that-is-gone" },
  identityCache: {},
  settings: SETTINGS,
  onboarding: { completed: true },
});

const legacyV2 = () => ({
  schemaVersion: 2,
  contacts: { c1: { id: "c1", username: "alice", nickname: "Nick", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", identityUpdatedAt: "2026-01-01T00:00:00.000Z" } },
  tombstones: {},
  identityIndex: {},
  identityCache: {},
  identityConflicts: {},
  settings: SETTINGS,
});

/** Installs storage plus the background's coordinators and records every key any set or remove ever touched. */
function install(initial: Record<string, unknown>) {
  const storage = installFakeChrome(initial, backgroundSendMessage());
  const touched: string[] = [];
  const realSet = storage.set;
  const realRemove = storage.remove;
  storage.set = (values) => {
    touched.push(...Object.keys(values));
    return realSet(values);
  };
  storage.remove = (keys) => {
    touched.push(...keys);
    return realRemove(keys);
  };
  return { storage, touched };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
const withoutDiagnostics = (snapshot: Record<string, unknown>) => {
  const { diagnostics: _diagnostics, ...payload } = snapshot;
  return payload;
};

beforeEach(() => {
  __resetMigrationCoordinatorForTests();
  __resetDiagnosticReportsForTests();
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
  vi.restoreAllMocks();
});

describe("recording a storage failure, for real, leaves the storage it reports on alone", () => {
  it("validation failure: the payload is byte-for-byte unchanged and only the diagnostics key is ever written", async () => {
    const original = invalidV4();
    const { storage, touched } = install(original);

    await expect(loadAndMigrateStorage()).rejects.toThrow();
    await settle();

    expect(JSON.stringify(withoutDiagnostics(storage.snapshot()))).toBe(JSON.stringify(original));
    expect(touched.length).toBeGreaterThan(0); // something was written - the event - or this proves nothing
    expect(new Set(touched)).toEqual(new Set(["diagnostics"]));
    expect(storage.snapshot().diagnostics).toEqual([
      expect.objectContaining({ code: "STORAGE_VALIDATION_FAILED", component: "storage" }),
    ]);
  });

  it("migration failure (a schema newer than this build): the same, with the migration code", async () => {
    const original = { schemaVersion: 99, contacts: { c1: { id: "c1" } }, unknown: "keep" };
    const { storage, touched } = install(original);

    await expect(loadAndMigrateStorage()).rejects.toThrow();
    await settle();

    expect(JSON.stringify(withoutDiagnostics(storage.snapshot()))).toBe(JSON.stringify(original));
    expect(new Set(touched)).toEqual(new Set(["diagnostics"]));
    expect(storage.snapshot().diagnostics).toEqual([expect.objectContaining({ code: "STORAGE_MIGRATION_FAILED" })]);
  });

  it("migration failure (the write is refused): the legacy storage is exactly as it was", async () => {
    const original = legacyV2();
    const { storage } = install(original);
    const realSet = storage.set;
    // Refuse the migration's own write; let the diagnostics write through.
    storage.set = (values) => (Object.hasOwn(values, "schemaVersion") ? Promise.reject(new Error("quota")) : realSet(values));

    await expect(loadAndMigrateStorage()).rejects.toThrow();
    await settle();

    expect(JSON.stringify(withoutDiagnostics(storage.snapshot()))).toBe(JSON.stringify(original));
    expect(storage.snapshot().diagnostics).toEqual([expect.objectContaining({ code: "STORAGE_MIGRATION_FAILED" })]);
  });

  it("carries no identifier out of the failure: the event is a code and a component, nothing from the storage", async () => {
    const { storage } = install(invalidV4());

    await expect(loadAndMigrateStorage()).rejects.toThrow();
    await settle();

    const recorded = JSON.stringify(storage.snapshot().diagnostics);
    expect(recorded).not.toMatch(new RegExp(`${OWNER}|dir-|alice|Nick|c1`));
  });
});
