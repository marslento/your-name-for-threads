import { afterEach, describe, expect, it } from "vitest";

import { BrowserStorageContactsRepository } from "../../src/storage/BrowserStorageContactsRepository";
import type { DirectoryRecord } from "../../src/domain/directory";
import type { ExtensionStorageV4 } from "../../src/storage/schema";
import { type FakeStorageArea, installFakeChrome } from "../fixtures/storage/fakeChromeStorage";

const OWNER = "900";
const DIR_ID = "test-directory-id";

function installStorage(directory: Partial<DirectoryRecord> = {}): FakeStorageArea {
  return installFakeChrome({
    schemaVersion: 4,
    directories: {
      [DIR_ID]: {
        directoryId: DIR_ID,
        contacts: {},
        tombstones: {},
        identityIndex: {},
        identityConflicts: {},
        ...directory,
      },
    },
    accountBindings: { [OWNER]: DIR_ID },
    identityCache: {},
    settings: { enabled: true, nicknameDisplay: { profile: true, feed: true, replies: true, quotes: true } },
  });
}

function directoryOf(area: FakeStorageArea) {
  return (area.snapshot() as ExtensionStorageV4).directories[DIR_ID];
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
});

describe("BrowserStorageContactsRepository.resolveConflict", () => {
  it.each(["duplicate", "__proto__"])("merges duplicate %s and persists its tombstone in one write", async (duplicateId) => {
    const canonical = {
      id: "canonical",
      threadsUserId: "123",
      username: "old",
      nickname: "Old",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      identityUpdatedAt: "2026-01-01T00:00:00.000Z",
    };
    const duplicate = {
      id: duplicateId,
      username: "new",
      nickname: "New",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      identityUpdatedAt: "2026-01-01T00:00:00.000Z",
    };
    const area = installStorage({
      contacts: { canonical, [duplicateId]: duplicate },
      identityIndex: { "username:old": "canonical", "threads:123": "canonical", "username:new": duplicateId },
      identityConflicts: {
        "conflict-1": {
          id: "conflict-1",
          threadsUserId: "123",
          contactIds: ["canonical", duplicateId],
          detectedAt: "2026-01-02T00:00:00.000Z",
        },
      },
    });
    const repository = new BrowserStorageContactsRepository();

    const result = await repository.resolveConflict(OWNER, {
      conflictId: "conflict-1",
      nickname: "Merged",
      note: "",
      expectedSources: [
        { contactId: "canonical", updatedAt: canonical.updatedAt, identityUpdatedAt: canonical.identityUpdatedAt },
        { contactId: duplicateId, updatedAt: duplicate.updatedAt, identityUpdatedAt: duplicate.identityUpdatedAt },
      ],
      now: "2026-01-03T00:00:00.000Z",
    });

    expect(result.type).toBe("resolved");
    const directory = directoryOf(area);
    expect(directory.contacts).toEqual({ canonical: { ...canonical, nickname: "Merged", updatedAt: "2026-01-03T00:00:00.000Z" } });
    expect(Object.hasOwn(directory.tombstones, duplicateId)).toBe(true);
    expect(directory.tombstones[duplicateId]).toMatchObject({ reason: "merged", mergedIntoContactId: "canonical" });
    expect(directory.identityConflicts).toEqual({});
    expect(area.writeCount()).toBe(1);
  });

  it("does not write anything when rejected as stale", async () => {
    const canonical = {
      id: "canonical",
      threadsUserId: "123",
      username: "old",
      nickname: "Old",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-05T00:00:00.000Z",
      identityUpdatedAt: "2026-01-01T00:00:00.000Z",
    };
    const duplicate = {
      id: "duplicate",
      username: "new",
      nickname: "New",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      identityUpdatedAt: "2026-01-01T00:00:00.000Z",
    };
    const area = installStorage({
      contacts: { canonical, duplicate },
      identityConflicts: {
        "conflict-1": {
          id: "conflict-1",
          threadsUserId: "123",
          contactIds: ["canonical", "duplicate"],
          detectedAt: "2026-01-02T00:00:00.000Z",
        },
      },
    });
    const repository = new BrowserStorageContactsRepository();

    const result = await repository.resolveConflict(OWNER, {
      conflictId: "conflict-1",
      nickname: "Merged",
      note: "",
      expectedSources: [
        { contactId: "canonical", updatedAt: "2026-01-01T00:00:00.000Z", identityUpdatedAt: canonical.identityUpdatedAt },
        { contactId: "duplicate", updatedAt: duplicate.updatedAt, identityUpdatedAt: duplicate.identityUpdatedAt },
      ],
      now: "2026-01-03T00:00:00.000Z",
    });

    expect(result).toEqual({ type: "stale" });
    expect(area.writeCount()).toBe(0);
  });

  it("reports missing without writing anything", async () => {
    const area = installStorage();
    const repository = new BrowserStorageContactsRepository();

    const result = await repository.resolveConflict(OWNER, {
      conflictId: "gone",
      nickname: "Merged",
      note: "",
      expectedSources: [],
      now: "2026-01-03T00:00:00.000Z",
    });

    expect(result).toEqual({ type: "missing" });
    expect(area.writeCount()).toBe(0);
  });
});
