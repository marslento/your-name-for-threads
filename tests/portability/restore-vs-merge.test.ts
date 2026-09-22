import { describe, expect, it } from "vitest";

import type { DirectorySnapshot } from "../../src/domain/directorySnapshot";
import type { ThreadContact } from "../../src/domain/contact";
import type { ContactTombstone } from "../../src/domain/tombstone";
import { analyzeRestore, analyzeSelfMerge } from "../../src/portability/analyzeImport";
import type { BackupSnapshotV2 } from "../../src/portability/backupTypes";
import { buildRestoreCandidate, buildSelfMergeCandidate } from "../../src/portability/buildCandidateSnapshot";
import { summarizeCandidateDiff } from "../../src/portability/importSummary";

const OWNER = "900";

function contact(id: string, updatedAt: string, nickname = id.toUpperCase()): ThreadContact {
  return {
    id,
    username: id,
    nickname,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
    identityUpdatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function tombstone(contactId: string, deletedAt: string): ContactTombstone {
  return {
    contactId,
    username: contactId,
    createdAt: "2026-01-01T00:00:00.000Z",
    deletedAt,
    reason: "user_deleted",
  };
}

/** T1, 10:00 - the backup was taken while A, B and C were all active. */
function backupAtT1(): BackupSnapshotV2 {
  return {
    format: "threads-private-directory-backup",
    backupVersion: 2,
    exportedBy: { threadsUserId: OWNER, username: "alice" },
    directoryId: "dir-1",
    exportedAt: "2026-02-01T10:00:00.000Z",
    contacts: [
      contact("a", "2026-02-01T09:00:00.000Z"),
      contact("b", "2026-02-01T09:00:00.000Z"),
      contact("c", "2026-02-01T09:00:00.000Z"),
    ],
    tombstones: [],
  };
}

/** T2 - since the backup, D was added and C was deleted at 12:00. */
function localAtT2(): DirectorySnapshot {
  return {
    directoryId: "dir-1",
    contacts: new Map([
      ["a", contact("a", "2026-02-01T09:00:00.000Z")],
      ["b", contact("b", "2026-02-01T09:00:00.000Z")],
      ["d", contact("d", "2026-02-01T11:00:00.000Z")],
    ]),
    tombstones: new Map([["c", tombstone("c", "2026-02-01T12:00:00.000Z")]]),
  };
}

function activeIds(snapshot: DirectorySnapshot): string[] {
  return [...snapshot.contacts.keys()].sort();
}

/**
 * The scenario that decides whether Restore and Merge are actually two
 * different operations (Phase 3.6 §7 vs §10-§12). If these two produce the
 * same Directory, Restore has been implemented as a Merge - the single most
 * consequential way to get this phase wrong, because it silently turns "put
 * my Directory back how it was" into "keep whatever is newer".
 */
describe("Restore vs Merge on the same backup (Phase 3.6 §7/§10-§12)", () => {
  it("Restore reinstates a contact deleted after the backup was taken", () => {
    const restored = buildRestoreCandidate(backupAtT1());

    expect(activeIds(restored)).toEqual(["a", "b", "c"]);
    expect(restored.tombstones.size).toBe(0);
  });

  it("Restore removes a contact added after the backup was taken", () => {
    const restored = buildRestoreCandidate(backupAtT1());

    expect(restored.contacts.has("d")).toBe(false);
    expect(restored.tombstones.has("d")).toBe(false);
  });

  it("Merge keeps the newer local deletion instead of resurrecting it", () => {
    const built = buildSelfMergeCandidate({
      latestLocal: localAtT2(),
      incoming: backupAtT1(),
      preflight: analyzeSelfMerge(localAtT2(), backupAtT1()),
      decisions: new Map(),
      operationNow: "2026-02-01T13:00:00.000Z",
    });

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(activeIds(built.candidate)).toEqual(["a", "b", "d"]);
    expect(built.candidate.tombstones.get("c")?.reason).toBe("user_deleted");
  });

  it("Merge keeps a local-only contact the backup never had", () => {
    const built = buildSelfMergeCandidate({
      latestLocal: localAtT2(),
      incoming: backupAtT1(),
      preflight: analyzeSelfMerge(localAtT2(), backupAtT1()),
      decisions: new Map(),
      operationNow: "2026-02-01T13:00:00.000Z",
    });

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.candidate.contacts.has("d")).toBe(true);
  });

  it("the two operations disagree on this backup - they are not the same code path wearing two names", () => {
    const restored = buildRestoreCandidate(backupAtT1());
    const merged = buildSelfMergeCandidate({
      latestLocal: localAtT2(),
      incoming: backupAtT1(),
      preflight: analyzeSelfMerge(localAtT2(), backupAtT1()),
      decisions: new Map(),
      operationNow: "2026-02-01T13:00:00.000Z",
    });

    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(activeIds(restored)).not.toEqual(activeIds(merged.candidate));
  });
});

describe("Restore Preflight counts (Phase 3.6 §9)", () => {
  it("counts a post-backup deletion as restored, a post-backup addition as removed, and the rest as unchanged", () => {
    const preflight = analyzeRestore(localAtT2(), backupAtT1());

    expect(preflight.mode).toBe("restore");
    // c comes back (its local tombstone is replaced by the backup's active record).
    expect(preflight.summary.create).toBe(1);
    // d is dropped.
    expect(preflight.summary.delete).toBe(1);
    // a and b are byte-identical on both sides.
    expect(preflight.summary.unchanged).toBe(2);
    expect(preflight.summary.update).toBe(0);
  });

  it("counts an edit made after the backup as a revert to the backup version", () => {
    const local: DirectorySnapshot = {
      directoryId: "dir-1",
      contacts: new Map([["a", contact("a", "2026-02-01T11:00:00.000Z", "Renamed")]]),
      tombstones: new Map(),
    };

    const preflight = analyzeRestore(local, backupAtT1());

    expect(preflight.summary.update).toBe(1);
    expect(preflight.summary.create).toBe(2);
    expect(preflight.summary.delete).toBe(0);
  });

  /** Restore is the user's one decision; re-asking per record would make it a Merge (Phase 3.6 §8, checklist #13). */
  it("never produces review items or blocking issues, whatever the local state is", () => {
    const preflight = analyzeRestore(localAtT2(), backupAtT1());

    expect(preflight.items).toEqual([]);
    expect(preflight.blockingIssues).toEqual([]);
  });
});

describe("Merge Preflight distinguishes 'local won' from 'nothing to do' (Phase 3.6 §14)", () => {
  it("reports a newer local deletion and a local-only contact separately from unchanged records", () => {
    const preflight = analyzeSelfMerge(localAtT2(), backupAtT1());

    expect(preflight.summary.keptLocalDeletion).toBe(1);
    // a and b match on both sides; d is local-only, which merge leaves alone.
    expect(preflight.summary.unchanged).toBe(3);
    expect(preflight.summary.delete).toBe(0);
  });

  it("reports a newer local edit as a kept local version, not as 'unchanged'", () => {
    const local: DirectorySnapshot = {
      directoryId: "dir-1",
      contacts: new Map([["a", contact("a", "2026-02-01T11:00:00.000Z", "Renamed")]]),
      tombstones: new Map(),
    };

    const preflight = analyzeSelfMerge(local, backupAtT1());

    expect(preflight.summary.keptLocalNewer).toBe(1);
    expect(preflight.summary.unchanged).toBe(0);
  });
});

describe("Restore result counts (Phase 3.6 §7)", () => {
  /**
   * Restore is the only operation that makes a record vanish outright rather
   * than tombstoning it, so the shared before/after diff has to have a branch
   * for it - without one, a removal is counted as nothing at all and the
   * Result page under-reports what just happened.
   */
  it("reports a record the backup does not contain as deleted, not as no change", () => {
    const diff = summarizeCandidateDiff(localAtT2(), buildRestoreCandidate(backupAtT1()));

    // d is gone entirely.
    expect(diff.deleted).toBe(1);
    // c comes back from its tombstone.
    expect(diff.resurrected).toBe(1);
  });
});
