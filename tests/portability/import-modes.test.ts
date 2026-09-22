import { describe, expect, it } from "vitest";

import type { DirectorySnapshot } from "../../src/domain/directorySnapshot";
import {
  availableImportModes,
  classifyImportLineage,
  defaultImportMode,
  isPristineDirectory,
} from "../../src/portability/importModes";

const CURRENT_OWNER = "900";
const OTHER_OWNER = "901";

function emptySnapshot(directoryId: string): DirectorySnapshot {
  return { directoryId, contacts: new Map(), tombstones: new Map() };
}

function nonPristineSnapshot(directoryId: string): DirectorySnapshot {
  return {
    directoryId,
    contacts: new Map([["a", { id: "a", username: "a", nickname: "A", createdAt: "", updatedAt: "", identityUpdatedAt: "" }]]),
    tombstones: new Map(),
  };
}

describe("isPristineDirectory", () => {
  it("is pristine with zero contacts, tombstones, and conflicts", () => {
    expect(isPristineDirectory({ contacts: new Map(), tombstones: new Map(), identityConflictCount: 0 })).toBe(true);
  });

  it("is not pristine with a tombstone even if there are zero active contacts", () => {
    const tombstones = new Map([["a", { contactId: "a", username: "a", createdAt: "", deletedAt: "", reason: "user_deleted" as const }]]);
    expect(isPristineDirectory({ contacts: new Map(), tombstones, identityConflictCount: 0 })).toBe(false);
  });

  it("is not pristine with a pending identity conflict", () => {
    expect(isPristineDirectory({ contacts: new Map(), tombstones: new Map(), identityConflictCount: 1 })).toBe(false);
  });
});

/**
 * Priority matrix (Phase 3.5 Task 34, Phase 3.6 §6): the exporting account
 * comes first and wins unconditionally, then directoryId equality, then
 * pristine - the reverse of directoryId-then-pristine before
 * account-scoping.
 */
describe("classifyImportLineage", () => {
  it("a different exporting account is always foreign, even with a matching directoryId (Phase 3.6 §6)", () => {
    const local = emptySnapshot("same-dir");

    expect(
      classifyImportLineage(local, 0, { directoryId: "same-dir", exportedByThreadsUserId: OTHER_OWNER }, CURRENT_OWNER),
    ).toBe("different_lineage");
  });

  it("a different exporting account is foreign even on a pristine local directory", () => {
    const local = emptySnapshot("local-dir");

    expect(
      classifyImportLineage(local, 0, { directoryId: "incoming-dir", exportedByThreadsUserId: OTHER_OWNER }, CURRENT_OWNER),
    ).toBe("different_lineage");
  });

  it("same account, same directoryId -> same lineage", () => {
    const local = nonPristineSnapshot("same-dir");

    expect(
      classifyImportLineage(local, 0, { directoryId: "same-dir", exportedByThreadsUserId: CURRENT_OWNER }, CURRENT_OWNER),
    ).toBe("same_lineage");
  });

  it("same account, same directoryId, pristine local -> still same lineage (directoryId wins before pristine)", () => {
    const local = emptySnapshot("same-dir");

    expect(
      classifyImportLineage(local, 0, { directoryId: "same-dir", exportedByThreadsUserId: CURRENT_OWNER }, CURRENT_OWNER),
    ).toBe("same_lineage");
  });

  it("same account, different directoryId, pristine local -> adoptable lineage (Phase 3.6 §22)", () => {
    const local = emptySnapshot("local-dir");

    expect(
      classifyImportLineage(local, 0, { directoryId: "old-dir", exportedByThreadsUserId: CURRENT_OWNER }, CURRENT_OWNER),
    ).toBe("adoptable_lineage");
  });

  it("same account, different directoryId, populated local -> foreign, never a destructive replace (Phase 3.6 §23)", () => {
    const local = nonPristineSnapshot("local-dir");

    expect(
      classifyImportLineage(local, 0, { directoryId: "other-dir", exportedByThreadsUserId: CURRENT_OWNER }, CURRENT_OWNER),
    ).toBe("different_lineage");
  });

  it("never-created account (empty directoryId placeholder) adopts the lineage of their own backup", () => {
    const local = emptySnapshot("");

    expect(
      classifyImportLineage(local, 0, { directoryId: "old-dir", exportedByThreadsUserId: CURRENT_OWNER }, CURRENT_OWNER),
    ).toBe("adoptable_lineage");
  });
});

describe("availableImportModes", () => {
  it("offers both Restore and Merge for a same-lineage backup, and nothing else (Phase 3.6 §5/§6)", () => {
    expect([...availableImportModes("same_lineage")].sort()).toEqual(["restore", "self_merge"]);
  });

  it("offers only Restore when there is no local Directory to defend (Phase 3.6 §22)", () => {
    expect(availableImportModes("adoptable_lineage")).toEqual(["restore"]);
  });

  it("never offers Restore or Merge for a foreign backup (Phase 3.6 §15)", () => {
    expect(availableImportModes("different_lineage")).toEqual(["external_import"]);
  });

  it("defaults a same-lineage session to Merge - the operation that cannot drop data the backup lacks", () => {
    expect(defaultImportMode("same_lineage")).toBe("self_merge");
    expect(defaultImportMode("adoptable_lineage")).toBe("restore");
    expect(defaultImportMode("different_lineage")).toBe("external_import");
  });
});
