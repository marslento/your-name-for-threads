import { describe, expect, it } from "vitest";

import type { ThreadContact } from "../../src/domain/contact";
import type { ContactTombstone } from "../../src/domain/tombstone";
import type { DirectorySnapshot } from "../../src/domain/directorySnapshot";
import { analyzeExternalImport } from "../../src/portability/analyzeImport";
import type { BackupSnapshotV2 } from "../../src/portability/backupTypes";

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

function backup(contacts: ThreadContact[]): BackupSnapshotV2 {
  return {
    format: "threads-private-directory-backup",
    backupVersion: 2,
    directoryId: "other-dir",
    exportedAt: "2026-02-01T00:00:00.000Z",
    contacts,
    tombstones: [
      {
        contactId: "irrelevant",
        username: "irrelevant",
        createdAt: "2026-01-01T00:00:00.000Z",
        deletedAt: "2026-01-02T00:00:00.000Z",
        reason: "user_deleted",
      },
    ],
  };
}

function localSnapshot(contacts: ThreadContact[] = [], tombstones: ContactTombstone[] = []): DirectorySnapshot {
  return {
    directoryId: "local-dir",
    contacts: new Map(contacts.map((c) => [c.id, c])),
    tombstones: new Map(tombstones.map((t) => [t.contactId, t])),
  };
}

describe("analyzeExternalImport", () => {
  it("categorizes new contacts", () => {
    const preflight = analyzeExternalImport(localSnapshot(), backup([contact({ id: "incoming-1" })]));

    expect(preflight.summary.create).toBe(1);
    expect(preflight.items[0]).toMatchObject({ kind: "external_new", requiresDecision: false });
  });

  it("never applies incoming tombstones (they have zero local effect)", () => {
    const preflight = analyzeExternalImport(localSnapshot(), backup([contact({ id: "incoming-1" })]));

    expect(preflight.items.some((item) => item.itemId.includes("irrelevant"))).toBe(false);
  });

  it("stable duplicates do not require decision under keep_local/use_incoming", () => {
    const local = contact({ id: "local-1", threadsUserId: "123" });
    const preflight = analyzeExternalImport(
      localSnapshot([local]),
      backup([contact({ id: "incoming-1", threadsUserId: "123" })]),
      "keep_local",
    );

    expect(preflight.summary.stableDuplicates).toBe(1);
    expect(preflight.items[0]).toMatchObject({ kind: "external_stable_duplicate", requiresDecision: false });
  });

  it("stable duplicates require decision under review_each", () => {
    const local = contact({ id: "local-1", threadsUserId: "123" });
    const preflight = analyzeExternalImport(
      localSnapshot([local]),
      backup([contact({ id: "incoming-1", threadsUserId: "123" })]),
      "review_each",
    );

    expect(preflight.items[0]).toMatchObject({ kind: "external_stable_duplicate", requiresDecision: true });
  });

  it("weak duplicates and identity mismatches always require a decision", () => {
    const local = contact({ id: "local-1", username: "alice" });
    const preflight = analyzeExternalImport(
      localSnapshot([local]),
      backup([contact({ id: "incoming-1", username: "alice" })]),
      "keep_local",
    );

    expect(preflight.items[0]).toMatchObject({ kind: "external_weak_duplicate", requiresDecision: true });
  });

  it("a merged tombstone whose canonical contact cannot be resolved produces a blocking issue, not a false success", () => {
    const merged: ContactTombstone = {
      contactId: "retired",
      username: "oldalice",
      threadsUserId: "123",
      createdAt: "2026-01-01T00:00:00.000Z",
      deletedAt: "2026-01-02T00:00:00.000Z",
      reason: "merged",
      mergedIntoContactId: "ghost-canonical",
    };
    const preflight = analyzeExternalImport(
      localSnapshot([], [merged]),
      backup([contact({ id: "incoming-1", threadsUserId: "123", username: "oldalice" })]),
    );

    expect(preflight.blockingIssues).toMatchObject([{ code: "unresolved_merged_lineage", contactId: "retired" }]);
  });

  it("a resolvable merged tombstone redirects to the canonical contact as a stable duplicate, with no blocking issue", () => {
    const canonical = contact({ id: "canonical", username: "newalice", threadsUserId: "123" });
    const merged: ContactTombstone = {
      contactId: "retired",
      username: "oldalice",
      threadsUserId: "123",
      createdAt: "2026-01-01T00:00:00.000Z",
      deletedAt: "2026-01-02T00:00:00.000Z",
      reason: "merged",
      mergedIntoContactId: "canonical",
    };
    const preflight = analyzeExternalImport(
      localSnapshot([canonical], [merged]),
      backup([contact({ id: "incoming-1", threadsUserId: "123", username: "oldalice" })]),
    );

    expect(preflight.blockingIssues).toEqual([]);
    expect(preflight.summary.stableDuplicates).toBe(1);
    expect(preflight.items[0]).toMatchObject({ kind: "external_stable_duplicate", contactId: "canonical" });
  });

  it("an unresolved local Phase 2 conflict (two active contacts sharing a stable ID) blocks instead of matching either one", () => {
    const localA = contact({ id: "local-a", threadsUserId: "123", username: "alice-a" });
    const localB = contact({ id: "local-b", threadsUserId: "123", username: "alice-b" });
    const preflight = analyzeExternalImport(
      localSnapshot([localA, localB]),
      backup([contact({ id: "incoming-1", threadsUserId: "123", username: "alice-renamed" })]),
    );

    expect(preflight.blockingIssues).toMatchObject([{ code: "ambiguous_local_identity" }]);
    expect(preflight.summary.stableDuplicates).toBe(0);
  });

  it("two incoming contacts that both match the same local stable duplicate block instead of the second one silently winning", () => {
    // Exact reproduction from the review: Preflight must show a blocking
    // issue, never "2 stable duplicates, 0 ambiguity" that then lets
    // use_incoming silently overwrite with whichever array entry is last.
    const local = contact({ id: "local-1", threadsUserId: "123", username: "alice" });
    const preflight = analyzeExternalImport(
      localSnapshot([local]),
      backup([
        contact({ id: "incoming-a", threadsUserId: "123", username: "alice-a" }),
        contact({ id: "incoming-b", threadsUserId: "123", username: "alice-b" }),
      ]),
      "use_incoming",
    );

    expect(preflight.blockingIssues).toMatchObject([
      { code: "duplicate_import_target", contactId: "local-1" },
      { code: "duplicate_import_target", contactId: "local-1" },
    ]);
    expect(preflight.summary.stableDuplicates).toBe(0);
  });

  it("blocks on the duplicate target regardless of incoming array order", () => {
    const local = contact({ id: "local-1", threadsUserId: "123", username: "alice" });
    const incomingA = contact({ id: "incoming-a", threadsUserId: "123", username: "alice-a" });
    const incomingB = contact({ id: "incoming-b", threadsUserId: "123", username: "alice-b" });

    const forward = analyzeExternalImport(localSnapshot([local]), backup([incomingA, incomingB]), "use_incoming");
    const reversed = analyzeExternalImport(localSnapshot([local]), backup([incomingB, incomingA]), "use_incoming");

    expect(forward.blockingIssues).toMatchObject([{ code: "duplicate_import_target" }, { code: "duplicate_import_target" }]);
    expect(reversed.blockingIssues).toMatchObject([{ code: "duplicate_import_target" }, { code: "duplicate_import_target" }]);
  });

  it("two incoming contacts matching the same local stable duplicate under keep_local do not block - neither one writes anything", () => {
    const local = contact({ id: "local-1", threadsUserId: "123", username: "alice" });
    const preflight = analyzeExternalImport(
      localSnapshot([local]),
      backup([
        contact({ id: "incoming-a", threadsUserId: "123", username: "alice-a" }),
        contact({ id: "incoming-b", threadsUserId: "123", username: "alice-b" }),
      ]),
      "keep_local",
    );

    expect(preflight.blockingIssues).toEqual([]);
    expect(preflight.summary.stableDuplicates).toBe(2);
  });

  it("two incoming contacts matching the same local stable duplicate under review_each do not block yet - each becomes its own review item", () => {
    const local = contact({ id: "local-1", threadsUserId: "123", username: "alice" });
    const preflight = analyzeExternalImport(
      localSnapshot([local]),
      backup([
        contact({ id: "incoming-a", threadsUserId: "123", username: "alice-a" }),
        contact({ id: "incoming-b", threadsUserId: "123", username: "alice-b" }),
      ]),
      "review_each",
    );

    expect(preflight.blockingIssues).toEqual([]);
    expect(preflight.items).toMatchObject([
      { kind: "external_stable_duplicate", requiresDecision: true, itemId: "external:incoming-a:stable" },
      { kind: "external_stable_duplicate", requiresDecision: true, itemId: "external:incoming-b:stable" },
    ]);
  });
});
