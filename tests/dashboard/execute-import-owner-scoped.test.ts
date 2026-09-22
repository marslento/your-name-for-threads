import { afterEach, describe, expect, it } from "vitest";

import { executeImport } from "../../src/dashboard/backup/executeImport";
import type { ThreadContact } from "../../src/domain/contact";
import { analyzeExternalImport } from "../../src/portability/analyzeImport";
import type { BackupSnapshotV2 } from "../../src/portability/backupTypes";
import { captureConcurrencyBaseline } from "../../src/portability/importConcurrency";
import { classifyImportLineage, defaultImportMode } from "../../src/portability/importModes";
import type { ImportSession } from "../../src/portability/importSession";
import { __resetDirectoryAccessQueueForTests } from "../../src/storage/directoryAccess";
import { BrowserDirectoryRepository } from "../../src/storage/BrowserDirectoryRepository";
import { __resetMigrationCoordinatorForTests } from "../../src/storage/migrations";
import { installFakeChrome } from "../fixtures/storage/fakeChromeStorage";
import { migrationCoordinatorSendMessage } from "../fixtures/storage/migrationCoordinator";

const BOB = "900";
const ALICE = "901";

function contact(overrides: Partial<ThreadContact> & { id: string }): ThreadContact {
  return {
    username: overrides.id,
    nickname: overrides.id,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    identityUpdatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function aliceBackup(contacts: ThreadContact[]): BackupSnapshotV2 {
  return {
    format: "threads-private-directory-backup",
    backupVersion: 2,
    exportedBy: { threadsUserId: ALICE, username: "alice" },
    directoryId: "dir-alice-export",
    exportedAt: "2026-02-01T00:00:00.000Z",
    contacts,
    tombstones: [],
  };
}

function counterUuid() {
  let n = 0;
  return () => `minted-${++n}`;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
  __resetMigrationCoordinatorForTests();
  __resetDirectoryAccessQueueForTests();
});

describe("owner-mismatch import commits only to the current owner's own Directory (Phase 3.5 Tasks 37-38)", () => {
  it("Task 37: a never-created Bob importing Alice's backup gets a fresh Directory, never adopting Alice's export id", async () => {
    installFakeChrome({}, migrationCoordinatorSendMessage());
    const repository = new BrowserDirectoryRepository();
    const incoming = aliceBackup([contact({ id: "a1", username: "alicefriend", nickname: "AliceFriend" })]);
    const localBaseline = { directoryId: "", contacts: new Map<string, ThreadContact>(), tombstones: new Map() };

    const lineage = classifyImportLineage(
      localBaseline,
      0,
      { directoryId: incoming.directoryId, exportedByThreadsUserId: incoming.exportedBy.threadsUserId },
      BOB,
    );
    const mode = defaultImportMode(lineage);
    expect(lineage).toBe("different_lineage");
    expect(mode).toBe("external_import");

    const preflight = analyzeExternalImport(localBaseline, incoming, "review_each");
    const session: ImportSession = {
      sessionId: "s1",
      lineage,
      mode,
      source: incoming,
      localBaseline,
      preflight,
      reviewDecisions: new Map(),
      concurrencyBaseline: captureConcurrencyBaseline(mode, localBaseline, incoming),
    };

    const outcome = await executeImport({
      ownerThreadsUserId: BOB,
      session,
      repository,
      clock: () => "2026-09-14T00:00:00.000Z",
      createUuid: counterUuid(),
    });

    expect(outcome.status).toBe("success");
    const bobDirectory = await repository.getDirectoryForOwner(BOB);
    expect(bobDirectory).toBeDefined();
    expect(bobDirectory!.directoryId).not.toBe("");
    expect(bobDirectory!.directoryId).not.toBe("dir-alice-export");
    expect(Object.values(bobDirectory!.contacts)).toHaveLength(1);
  });

  it("Task 37: two different never-created owners importing on the same commit never collide on the same directoryId", async () => {
    installFakeChrome({}, migrationCoordinatorSendMessage());
    const repository = new BrowserDirectoryRepository();
    const localBaseline = { directoryId: "", contacts: new Map<string, ThreadContact>(), tombstones: new Map() };
    const mintUuid = counterUuid();

    async function importFor(ownerThreadsUserId: string, fromOwner: string) {
      const incoming = aliceBackup([contact({ id: "x", username: "x", nickname: "X" })]);
      incoming.exportedBy = { threadsUserId: fromOwner, username: "someone" };
      const lineage = classifyImportLineage(
        localBaseline,
        0,
        { directoryId: incoming.directoryId, exportedByThreadsUserId: incoming.exportedBy.threadsUserId },
        ownerThreadsUserId,
      );
      const mode = defaultImportMode(lineage);
      const preflight = analyzeExternalImport(localBaseline, incoming, "review_each");
      const session: ImportSession = {
        sessionId: ownerThreadsUserId,
        lineage,
        mode,
        source: incoming,
        localBaseline,
        preflight,
        reviewDecisions: new Map(),
        concurrencyBaseline: captureConcurrencyBaseline(mode, localBaseline, incoming),
      };
      return executeImport({
        ownerThreadsUserId,
        session,
        repository,
        clock: () => "2026-09-14T00:00:00.000Z",
        createUuid: mintUuid,
      });
    }

    await importFor(BOB, "999");
    await importFor("902", "998");

    const bobDirectory = await repository.getDirectoryForOwner(BOB);
    const otherDirectory = await repository.getDirectoryForOwner("902");
    expect(bobDirectory!.directoryId).not.toBe("");
    expect(otherDirectory!.directoryId).not.toBe("");
    expect(bobDirectory!.directoryId).not.toBe(otherDirectory!.directoryId);
  });

  it("Task 38: an existing Bob Directory absorbs the import; a separately-stored Alice Directory is untouched", async () => {
    const bobContact = contact({ id: "bobc1", username: "bobfriend", nickname: "BobFriend" });
    const aliceContact = contact({ id: "alicec1", username: "aliceslivefriend", nickname: "AliceLiveFriend" });
    const area = installFakeChrome(
      {
        schemaVersion: 4,
        directories: {
          "dir-bob": { directoryId: "dir-bob", contacts: { bobc1: bobContact }, tombstones: {}, identityIndex: {}, identityConflicts: {} },
          "dir-alice-live": { directoryId: "dir-alice-live", contacts: { alicec1: aliceContact }, tombstones: {}, identityIndex: {}, identityConflicts: {} },
        },
        accountBindings: { [BOB]: "dir-bob", [ALICE]: "dir-alice-live" },
      },
      migrationCoordinatorSendMessage(),
    );
    const repository = new BrowserDirectoryRepository();
    const incoming = aliceBackup([contact({ id: "newperson", username: "newperson", nickname: "NewPerson" })]);
    const localDirectory = await repository.getDirectoryForOwner(BOB);
    const localBaseline = {
      directoryId: localDirectory!.directoryId,
      contacts: new Map(Object.entries(localDirectory!.contacts)),
      tombstones: new Map(),
    };

    const lineage = classifyImportLineage(
      localBaseline,
      0,
      { directoryId: incoming.directoryId, exportedByThreadsUserId: incoming.exportedBy.threadsUserId },
      BOB,
    );
    const mode = defaultImportMode(lineage);
    expect(lineage).toBe("different_lineage");
    expect(mode).toBe("external_import");

    const preflight = analyzeExternalImport(localBaseline, incoming, "review_each");
    const session: ImportSession = {
      sessionId: "s1",
      lineage,
      mode,
      source: incoming,
      localBaseline,
      preflight,
      reviewDecisions: new Map(),
      concurrencyBaseline: captureConcurrencyBaseline(mode, localBaseline, incoming),
    };

    const aliceBefore = structuredClone((area.snapshot() as { directories: Record<string, unknown> }).directories["dir-alice-live"]);

    const outcome = await executeImport({
      ownerThreadsUserId: BOB,
      session,
      repository,
      clock: () => "2026-09-14T00:00:00.000Z",
      createUuid: counterUuid(),
    });

    expect(outcome.status).toBe("success");
    const snapshot = area.snapshot() as { directories: Record<string, { directoryId: string; contacts: Record<string, ThreadContact> }> };
    expect(snapshot.directories["dir-alice-live"]).toEqual(aliceBefore);
    expect(snapshot.directories["dir-bob"].directoryId).toBe("dir-bob");
    const bobUsernames = Object.values(snapshot.directories["dir-bob"].contacts)
      .map((contact) => contact.username)
      .sort();
    expect(bobUsernames).toEqual(["bobfriend", "newperson"]);
  });
});
