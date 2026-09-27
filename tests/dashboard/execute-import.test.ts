import { afterEach, describe, expect, it } from "vitest";

import type { ThreadContact } from "../../src/domain/contact";
import { DirectoryFullError, type DirectoryRecord } from "../../src/domain/directory";
import { executeImport } from "../../src/dashboard/backup/executeImport";
import { analyzeSelfMerge } from "../../src/portability/analyzeImport";
import type { BackupSnapshotV2 } from "../../src/portability/backupTypes";
import { captureConcurrencyBaseline } from "../../src/portability/importConcurrency";
import type { ImportSession } from "../../src/portability/importSession";
import { BrowserDirectoryRepository } from "../../src/storage/BrowserDirectoryRepository";
import { __resetDirectoryAccessQueueForTests, mutateOwnerDirectory } from "../../src/storage/directoryAccess";
import type { DirectoryRepository } from "../../src/storage/DirectoryRepository";
import { __resetMigrationCoordinatorForTests } from "../../src/storage/migrations";
import { installFakeChrome } from "../fixtures/storage/fakeChromeStorage";
import { migrationCoordinatorSendMessage } from "../fixtures/storage/migrationCoordinator";

const OWNER = "900";
const DIR_ID = "dir-1";

function contact(overrides: Partial<ThreadContact>): ThreadContact {
  return {
    id: overrides.id ?? "a",
    username: "alice",
    nickname: "Alice",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    identityUpdatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function directoryWith(contacts: DirectoryRecord["contacts"] = {}): DirectoryRecord {
  return { directoryId: DIR_ID, contacts, tombstones: {}, identityIndex: {}, identityConflicts: {} };
}

function fakeRepository(
  initial: DirectoryRecord,
): DirectoryRepository & { setCount: () => number; latest: () => DirectoryRecord } {
  let state = structuredClone(initial);
  let setCount = 0;
  return {
    async getDirectoryForOwner(owner: string) {
      return owner === OWNER ? structuredClone(state) : undefined;
    },
    async getDirectoryById(id: string) {
      return id === state.directoryId ? structuredClone(state) : undefined;
    },
    async commitOwnerDirectory(input) {
      const outcome = input.mutate(structuredClone(state));
      if (!outcome.write) return outcome.result;
      setCount += 1;
      state = outcome.record;
      return outcome.result;
    },
    setCount: () => setCount,
    latest: () => state,
  };
}

function backup(contacts: ThreadContact[]): BackupSnapshotV2 {
  return {
    format: "threads-private-directory-backup",
    backupVersion: 2,
    exportedBy: { threadsUserId: OWNER, username: "owner" },
    directoryId: DIR_ID,
    exportedAt: "2026-02-01T00:00:00.000Z",
    contacts,
    tombstones: [],
  };
}

describe("executeImport", () => {
  it("refuses a self-merge username collision without writing either private record", async () => {
    const localContact = contact({ id: "a", nickname: "Private local name", threadsUserId: "123" });
    const initial = directoryWith({ a: localContact });
    const repository = fakeRepository(initial);
    const localSnapshot = { directoryId: DIR_ID, contacts: new Map([["a", localContact]]), tombstones: new Map() };
    // Each snapshot is valid separately, but merging them would bind alice to two people.
    const incoming = backup([contact({ id: "b", nickname: "Different person", threadsUserId: "456" })]);
    const session: ImportSession = {
      sessionId: "collision",
      lineage: "same_lineage",
      mode: "self_merge",
      source: incoming,
      localBaseline: localSnapshot,
      preflight: analyzeSelfMerge(localSnapshot, incoming),
      reviewDecisions: new Map(),
      concurrencyBaseline: captureConcurrencyBaseline("self_merge", localSnapshot, incoming),
    };

    const outcome = await executeImport({
      ownerThreadsUserId: OWNER, session, repository,
      clock: () => "2026-09-14T00:00:00.000Z", createUuid: () => "generated-1",
    });

    expect(outcome).toMatchObject({ status: "invalid_candidate", issues: expect.arrayContaining([
      { code: "duplicate_username", contactId: "b", username: "alice" },
    ]) });
    expect(repository.setCount()).toBe(0);
    expect(repository.latest()).toEqual(initial);
  });

  it("commits a self-merge with exactly one repository write", async () => {
    const localContact = contact({ id: "a", nickname: "Local", updatedAt: "2026-01-01T00:00:00.000Z" });
    const repository = fakeRepository(directoryWith({ a: localContact }));

    const localSnapshot = { directoryId: DIR_ID, contacts: new Map([["a", localContact]]), tombstones: new Map() };
    const incomingBackup = backup([contact({ id: "b", username: "bob", nickname: "New" })]);
    const preflight = analyzeSelfMerge(localSnapshot, incomingBackup);
    const baseline = captureConcurrencyBaseline("self_merge", localSnapshot, incomingBackup);

    const session: ImportSession = {
      sessionId: "s1",
      lineage: "same_lineage",
      mode: "self_merge",
      source: incomingBackup,
      localBaseline: localSnapshot,
      preflight,
      reviewDecisions: new Map(),
      concurrencyBaseline: baseline,
    };

    const outcome = await executeImport({
      ownerThreadsUserId: OWNER,
      session,
      repository,
      clock: () => "2026-09-14T00:00:00.000Z",
      createUuid: () => "generated-1",
    });

    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") return;
    expect(outcome.result.created).toBe(1);
    expect(repository.setCount()).toBe(1);
    expect(repository.latest().contacts).toHaveProperty("a");
    expect(repository.latest().contacts).toHaveProperty("b");
  });

  it("counts an incoming-only tombstone (adopted deletion history) as created, matching the preflight's own categorization", async () => {
    const repository = fakeRepository(directoryWith());
    const localSnapshot = { directoryId: DIR_ID, contacts: new Map(), tombstones: new Map() };
    const incomingBackup: BackupSnapshotV2 = {
      format: "threads-private-directory-backup",
      backupVersion: 2,
      exportedBy: { threadsUserId: OWNER, username: "owner" },
      directoryId: DIR_ID,
      exportedAt: "2026-02-01T00:00:00.000Z",
      contacts: [],
      tombstones: [
        {
          contactId: "gone-1",
          username: "gone",
          createdAt: "2026-01-01T00:00:00.000Z",
          deletedAt: "2026-01-02T00:00:00.000Z",
          reason: "user_deleted",
        },
      ],
    };
    const preflight = analyzeSelfMerge(localSnapshot, incomingBackup);
    expect(preflight.summary.create).toBe(1); // preflight already counts this as create

    const session: ImportSession = {
      sessionId: "s1",
      lineage: "same_lineage",
      mode: "self_merge",
      source: incomingBackup,
      localBaseline: localSnapshot,
      preflight,
      reviewDecisions: new Map(),
      concurrencyBaseline: captureConcurrencyBaseline("self_merge", localSnapshot, incomingBackup),
    };

    const outcome = await executeImport({
      ownerThreadsUserId: OWNER,
      session,
      repository,
      clock: () => "2026-09-14T00:00:00.000Z",
      createUuid: () => "id",
    });

    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") return;
    expect(outcome.result.created).toBe(1);
  });

  it("blocks commit when a relevant contact changed since the baseline", async () => {
    const localContact = contact({ id: "a", nickname: "Local", updatedAt: "2026-01-01T00:00:00.000Z" });
    const localSnapshot = { directoryId: DIR_ID, contacts: new Map([["a", localContact]]), tombstones: new Map() };
    const incomingBackup = backup([contact({ id: "a", nickname: "Incoming", updatedAt: "2026-01-01T00:00:00.000Z" })]);
    const preflight = analyzeSelfMerge(localSnapshot, incomingBackup);
    const baseline = captureConcurrencyBaseline("self_merge", localSnapshot, incomingBackup);

    // The contact changed after the baseline was captured.
    const changedContact = { ...localContact, updatedAt: "2026-05-01T00:00:00.000Z" };
    const repository = fakeRepository(directoryWith({ a: changedContact }));

    const session: ImportSession = {
      sessionId: "s1",
      lineage: "same_lineage",
      mode: "self_merge",
      source: incomingBackup,
      localBaseline: localSnapshot,
      preflight,
      reviewDecisions: new Map([["contact:a:private", { kind: "keep_local", itemId: "contact:a:private" }]]),
      concurrencyBaseline: baseline,
    };

    const outcome = await executeImport({
      ownerThreadsUserId: OWNER,
      session,
      repository,
      clock: () => "2026-09-14T00:00:00.000Z",
      createUuid: () => "id",
    });

    expect(outcome.status).toBe("concurrency_conflict");
    expect(repository.setCount()).toBe(0);
  });

  it.each([
    ["commit_failed", new Error("storage full")],
    ["directory_full", new DirectoryFullError()],
  ] as const)("reports %s instead of a false success when the repository write throws", async (status, thrown) => {
    const localSnapshot = { directoryId: DIR_ID, contacts: new Map(), tombstones: new Map() };
    const incomingBackup = backup([contact({ id: "a" })]);
    const preflight = analyzeSelfMerge(localSnapshot, incomingBackup);

    const repository: DirectoryRepository = {
      async getDirectoryForOwner() {
        return directoryWith();
      },
      async getDirectoryById() {
        return directoryWith();
      },
      async commitOwnerDirectory() {
        throw thrown;
      },
    };

    const session: ImportSession = {
      sessionId: "s1",
      lineage: "same_lineage",
      mode: "self_merge",
      source: incomingBackup,
      localBaseline: localSnapshot,
      preflight,
      reviewDecisions: new Map(),
      concurrencyBaseline: captureConcurrencyBaseline("self_merge", localSnapshot, incomingBackup),
    };

    const outcome = await executeImport({
      ownerThreadsUserId: OWNER,
      session,
      repository,
      clock: () => "2026-09-14T00:00:00.000Z",
      createUuid: () => "id",
    });

    expect(outcome.status).toBe(status);
  });
});

describe("executeImport — concurrency check runs against the lock-held read, not an earlier one (Phase 3.5 review round 4, High #5)", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "chrome");
    __resetMigrationCoordinatorForTests();
    __resetDirectoryAccessQueueForTests();
  });

  it("catches a write landing after the session's baseline but before commit, via the real repository/lock - and never loses it", async () => {
    const baselineContact = contact({ id: "a", nickname: "Local", updatedAt: "2026-01-01T00:00:00.000Z" });
    installFakeChrome(
      {
        schemaVersion: 4,
        directories: { [DIR_ID]: directoryWith({ a: baselineContact }) },
        accountBindings: { [OWNER]: DIR_ID },
      },
      migrationCoordinatorSendMessage(),
    );
    const repository = new BrowserDirectoryRepository();

    // The session's baseline is captured once, up front (mirrors
    // ImportSessionProvider.buildSession reading storage at session-build
    // time, well before the user actually confirms the import).
    const localSnapshot = { directoryId: DIR_ID, contacts: new Map([["a", baselineContact]]), tombstones: new Map() };
    const incomingBackup = backup([contact({ id: "a", nickname: "Incoming", updatedAt: "2026-01-01T00:00:00.000Z" })]);
    const preflight = analyzeSelfMerge(localSnapshot, incomingBackup);
    const session: ImportSession = {
      sessionId: "s1",
      lineage: "same_lineage",
      mode: "self_merge",
      source: incomingBackup,
      localBaseline: localSnapshot,
      preflight,
      reviewDecisions: new Map([["contact:a:private", { kind: "keep_local", itemId: "contact:a:private" }]]),
      concurrencyBaseline: captureConcurrencyBaseline("self_merge", localSnapshot, incomingBackup),
    };

    // A separate context (e.g. a content-script nickname edit) writes to the
    // SAME owner's Directory after the baseline above was captured, but
    // before executeImport ever runs.
    const newerContact = { ...baselineContact, nickname: "Edited elsewhere", updatedAt: "2026-05-01T00:00:00.000Z" };
    await mutateOwnerDirectory({
      ownerThreadsUserId: OWNER,
      createDirectoryId: () => "unused",
      mutate: (current) => ({
        write: true,
        record: { ...current, contacts: { ...current.contacts, a: newerContact } },
        result: undefined,
      }),
    });

    const outcome = await executeImport({
      ownerThreadsUserId: OWNER,
      session,
      repository,
      clock: () => "2026-09-14T00:00:00.000Z",
      createUuid: () => "id",
    });

    // Checking concurrency against a stale pre-lock read would have missed
    // this - the whole point of the fix is that the check re-runs against
    // whatever `mutateOwnerDirectory` hands `mutate` AFTER the lock is held.
    expect(outcome.status).toBe("concurrency_conflict");
    const stored = await repository.getDirectoryForOwner(OWNER);
    expect(stored?.contacts.a).toEqual(newerContact);
  });
});
