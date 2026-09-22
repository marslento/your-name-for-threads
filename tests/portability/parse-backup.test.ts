import { describe, expect, it } from "vitest";

import { parseBackupText } from "../../src/portability/parseBackup";

const OWNER = { threadsUserId: "900", username: "alice" };

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
