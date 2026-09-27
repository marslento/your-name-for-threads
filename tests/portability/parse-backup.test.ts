import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_DIRECTORY_RECORDS } from "../../src/domain/directory";
import { MAX_NICKNAME_LENGTH, MAX_NOTE_LENGTH } from "../../src/domain/validation";
import { BackupSnapshotV2Schema } from "../../src/portability/backupSchema";
import { parseBackupText } from "../../src/portability/parseBackup";
import { segmentsPulled } from "../fixtures/segmentsPulled";

const OWNER = { threadsUserId: "900", username: "alice" };
const AT = "2026-01-01T00:00:00.000Z";
const contactAt = (index: number) => ({
  id: `contact-${index}`, username: `user${index}`, nickname: "N", createdAt: AT, updatedAt: AT, identityUpdatedAt: AT,
});

const validText = () =>
  JSON.stringify({
    format: "threads-private-directory-backup",
    backupVersion: 2,
    exportedBy: OWNER,
    directoryId: "dir-1",
    exportedAt: "2026-01-01T00:00:00.000Z",
    contacts: [],
    tombstones: [],
  });

describe("parseBackupText", () => {
  it("rejects duplicate canonical usernames in an untrusted backup", () => {
    const backup = JSON.parse(validText());
    backup.contacts = ["alice", "alice"].map((username, index) => ({
      id: `contact-${index}`, username, nickname: "Private name",
      threadsUserId: String(100 + index),
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      identityUpdatedAt: "2026-01-01T00:00:00.000Z",
    }));

    expect(parseBackupText(JSON.stringify(backup))).toMatchObject({
      ok: false, error: { code: "invalid_invariant" },
    });
  });

  it("parses a valid V2 backup", () => {
    const result = parseBackupText(validText());

    expect(result.ok).toBe(true);
  });

  it("rejects invalid JSON", () => {
    const result = parseBackupText("{ not json");

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_json" } });
  });

  it("rejects the wrong format", () => {
    const result = parseBackupText(JSON.stringify({ format: "something-else", backupVersion: 1 }));

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_format" } });
  });

  it("rejects a backup version newer than the current version", () => {
    const result = parseBackupText(
      JSON.stringify({
        format: "threads-private-directory-backup",
        backupVersion: 3,
        exportedBy: OWNER,
        directoryId: "dir-1",
        exportedAt: "2026-01-01T00:00:00.000Z",
        contacts: [],
        tombstones: [],
      }),
    );

    expect(result).toMatchObject({ ok: false, error: { code: "newer_version" } });
  });

  it("rejects a V1 backup (pre-account-scoping, unsupported development format - Phase 3.5 Task 32)", () => {
    const result = parseBackupText(
      JSON.stringify({
        format: "threads-private-directory-backup",
        backupVersion: 1,
        directoryId: "dir-1",
        exportedAt: "2026-01-01T00:00:00.000Z",
        contacts: [],
        tombstones: [],
      }),
    );

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_schema" } });
  });

  it("rejects a schema violation", () => {
    const result = parseBackupText(
      JSON.stringify({
        format: "threads-private-directory-backup",
        backupVersion: 2,
        exportedBy: OWNER,
        directoryId: "dir-1",
        exportedAt: "2026-01-01T00:00:00.000Z",
        contacts: [{ id: "a" }],
        tombstones: [],
      }),
    );

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_schema" } });
  });

  it("rejects an invariant violation", () => {
    const result = parseBackupText(
      JSON.stringify({
        format: "threads-private-directory-backup",
        backupVersion: 2,
        exportedBy: OWNER,
        directoryId: "dir-1",
        exportedAt: "2026-01-01T00:00:00.000Z",
        contacts: [
          {
            id: "a",
            username: "alice",
            nickname: "Alice",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            identityUpdatedAt: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "a",
            username: "alice2",
            nickname: "Alice2",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            identityUpdatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        tombstones: [],
      }),
    );

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_invariant" } });
  });
});

describe("the work a crafted file can cause (Codex Security scan 0905)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("imports a backup with exactly the record limit of contacts, through the schema", () => {
    const backup = JSON.parse(validText());
    backup.contacts = Array.from({ length: MAX_DIRECTORY_RECORDS }, (_, index) => contactAt(index));
    const safeParse = vi.spyOn(BackupSnapshotV2Schema, "safeParse");

    expect(parseBackupText(JSON.stringify(backup)).ok).toBe(true);
    expect(safeParse).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["all contacts", MAX_DIRECTORY_RECORDS + 1, 0],
    ["all deleted records", 0, MAX_DIRECTORY_RECORDS + 1],
    ["the two lists together, each under the limit", MAX_DIRECTORY_RECORDS / 2, MAX_DIRECTORY_RECORDS / 2 + 1],
  ])("refuses one record over the limit, %s, before the schema reads any of them", (_split, contacts, tombstones) => {
    const backup = JSON.parse(validText());
    backup.contacts = Array.from({ length: contacts }, () => null);
    backup.tombstones = Array.from({ length: tombstones }, () => null);
    const safeParse = vi.spyOn(BackupSnapshotV2Schema, "safeParse");

    expect(parseBackupText(JSON.stringify(backup))).toMatchObject({ ok: false, error: { code: "invalid_schema" } });
    expect(safeParse).not.toHaveBeenCalled();
  });

  it("refuses a file whose bad fields overflow the schema's own error collection, instead of throwing", () => {
    const backup = JSON.parse(validText());
    const everyFieldWrong = { id: 1, threadsUserId: 1, username: 1, nickname: 1, note: 1, createdAt: 1, updatedAt: 1, identityUpdatedAt: 1, extra: 1 };
    backup.contacts = Array.from({ length: MAX_DIRECTORY_RECORDS }, () => everyFieldWrong);

    expect(parseBackupText(JSON.stringify(backup))).toMatchObject({ ok: false, error: { code: "invalid_schema" } });
  });

  it.each([
    ["nickname", MAX_NICKNAME_LENGTH],
    ["note", MAX_NOTE_LENGTH],
  ] as const)("reads an oversized %s only to one past its limit before refusing the file", (field, limit) => {
    const backup = JSON.parse(validText());
    backup.contacts = [{ ...contactAt(0), [field]: "a".repeat(100_000) }];
    let result: unknown;

    const pulled = segmentsPulled(() => {
      result = parseBackupText(JSON.stringify(backup));
    });

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_schema" } });
    expect(pulled, "one past the limit, and the one-letter nickname beside an oversized note").toBeLessThanOrEqual(limit + 2);
  });
});
