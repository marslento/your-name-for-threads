import { describe, expect, it } from "vitest";

import type { ThreadContact } from "../../src/domain/contact";
import type { ContactTombstone } from "../../src/domain/tombstone";
import type { DirectorySnapshot } from "../../src/domain/directorySnapshot";
import { analyzeSelfMerge } from "../../src/portability/analyzeImport";
import type { BackupSnapshotV2 } from "../../src/portability/backupTypes";
import { buildSelfMergeCandidate } from "../../src/portability/buildCandidateSnapshot";
import type { ImportReviewDecision } from "../../src/portability/reviewDecisions";

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

function backup(overrides: Partial<BackupSnapshotV2>): BackupSnapshotV2 {
  return {
    format: "threads-private-directory-backup",
    backupVersion: 2,
    directoryId: "dir-1",
    exportedAt: "2026-02-01T00:00:00.000Z",
    contacts: [],
    tombstones: [],
    ...overrides,
  };
}

function snapshot(contacts: ThreadContact[] = [], tombstones: ContactTombstone[] = []): DirectorySnapshot {
  return {
    directoryId: "dir-1",
    contacts: new Map(contacts.map((c) => [c.id, c])),
    tombstones: new Map(tombstones.map((t) => [t.contactId, t])),
  };
}

describe("buildSelfMergeCandidate", () => {
  it("fails when a required review decision is missing", () => {
    const local = snapshot([contact({ id: "a", nickname: "Local", updatedAt: "2026-01-01T00:00:00.000Z" })]);
    const incomingBackup = backup({ contacts: [contact({ id: "a", nickname: "Incoming", updatedAt: "2026-01-01T00:00:00.000Z" })] });
    const preflight = analyzeSelfMerge(local, incomingBackup);

    const result = buildSelfMergeCandidate({
      latestLocal: local,
      incoming: incomingBackup,
      preflight,
      decisions: new Map(),
      operationNow: "2026-09-14T00:00:00.000Z",
    });

    expect(result).toMatchObject({ ok: false, issues: [{ type: "missing_decision", itemId: "contact:a:private" }] });
  });

  it("applies a custom_private_data review decision and stamps operationNow", () => {
    const local = snapshot([contact({ id: "a", nickname: "Local", updatedAt: "2026-01-01T00:00:00.000Z" })]);
    const incomingBackup = backup({ contacts: [contact({ id: "a", nickname: "Incoming", updatedAt: "2026-01-01T00:00:00.000Z" })] });
    const preflight = analyzeSelfMerge(local, incomingBackup);
    const decisions = new Map<string, ImportReviewDecision>([
      ["contact:a:private", { kind: "custom_private_data", itemId: "contact:a:private", nickname: "Both", note: "merged manually" }],
    ]);

    const result = buildSelfMergeCandidate({
      latestLocal: local,
      incoming: incomingBackup,
      preflight,
      decisions,
      operationNow: "2026-09-14T00:00:00.000Z",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.contacts.get("a")).toMatchObject({
      nickname: "Both",
      note: "merged manually",
      updatedAt: "2026-09-14T00:00:00.000Z",
    });
  });

  it("resolves active-vs-tombstone equal-timestamp ambiguity via keep_active", () => {
    const local = snapshot([contact({ id: "a", updatedAt: "2026-01-01T00:00:00.000Z" })]);
    const incomingTombstone: ContactTombstone = {
      contactId: "a",
      username: "alice",
      createdAt: "2026-01-01T00:00:00.000Z",
      deletedAt: "2026-01-01T00:00:00.000Z",
      reason: "user_deleted",
    };
    const incomingBackup = backup({ tombstones: [incomingTombstone] });
    const preflight = analyzeSelfMerge(local, incomingBackup);
    const decisions = new Map<string, ImportReviewDecision>([
      ["contact:a:lifecycle", { kind: "keep_active", itemId: "contact:a:lifecycle" }],
    ]);

    const result = buildSelfMergeCandidate({ latestLocal: local, incoming: incomingBackup, preflight, decisions, operationNow: "2026-09-14T00:00:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.contacts.has("a")).toBe(true);
    expect(result.candidate.tombstones.has("a")).toBe(false);
  });

  it("a blocking stable identity contradiction is never bypassable by a decision", () => {
    const local = snapshot([contact({ id: "a", threadsUserId: "123" })]);
    const incomingBackup = backup({ contacts: [contact({ id: "a", threadsUserId: "999" })] });
    const preflight = analyzeSelfMerge(local, incomingBackup);

    const result = buildSelfMergeCandidate({
      latestLocal: local,
      incoming: incomingBackup,
      preflight,
      decisions: new Map([["contact:a:private", { kind: "keep_local", itemId: "contact:a:private" }]]),
      operationNow: "2026-09-14T00:00:00.000Z",
    });

    expect(result).toMatchObject({ ok: false, issues: [{ type: "blocking" }] });
  });

  it("preserves local-only and backup-only records untouched (union, not replace)", () => {
    const localOnly = contact({ id: "local-only", nickname: "LocalOnly" });
    const local = snapshot([localOnly]);
    const incomingOnly = contact({ id: "incoming-only", nickname: "IncomingOnly" });
    const incomingBackup = backup({ contacts: [incomingOnly] });
    const preflight = analyzeSelfMerge(local, incomingBackup);

    const result = buildSelfMergeCandidate({ latestLocal: local, incoming: incomingBackup, preflight, decisions: new Map(), operationNow: "2026-09-14T00:00:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.contacts.get("local-only")).toEqual(localOnly);
    expect(result.candidate.contacts.get("incoming-only")).toEqual(incomingOnly);
  });
});
