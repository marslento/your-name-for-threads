import { describe, expect, it } from "vitest";

import type { ThreadContact } from "../../src/domain/contact";
import type { ContactTombstone } from "../../src/domain/tombstone";
import type { DirectorySnapshot } from "../../src/domain/directorySnapshot";
import { analyzeExternalImport } from "../../src/portability/analyzeImport";
import type { BackupSnapshotV2 } from "../../src/portability/backupTypes";
import { buildExternalImportCandidate } from "../../src/portability/buildCandidateSnapshot";
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

function backup(contacts: ThreadContact[]): BackupSnapshotV2 {
  return {
    format: "threads-private-directory-backup",
    backupVersion: 2,
    directoryId: "other-dir",
    exportedAt: "2026-02-01T00:00:00.000Z",
    contacts,
    tombstones: [],
  };
}

function localSnapshot(contacts: ThreadContact[] = [], tombstones: ContactTombstone[] = []): DirectorySnapshot {
  return {
    directoryId: "local-dir",
    contacts: new Map(contacts.map((c) => [c.id, c])),
    tombstones: new Map(tombstones.map((t) => [t.contactId, t])),
  };
}

let uuidCounter = 0;
function createUuid(): string {
  uuidCounter += 1;
  return `generated-${uuidCounter}`;
}

describe("buildExternalImportCandidate", () => {
  it("keeps a weak match unchanged when the user declines identity confirmation", () => {
    const local = contact({ id: "local-1", username: "alice", nickname: "Private local name", note: "Private note" });
    const localState = localSnapshot([local]);
    const incoming = backup([contact({ id: "incoming-1", username: "alice", threadsUserId: "123" })]);
    const result = buildExternalImportCandidate({
      latestLocal: localState, incoming,
      preflight: analyzeExternalImport(localState, incoming),
      strategy: "review_each",
      decisions: new Map([["external:incoming-1:weak", { kind: "keep_local", itemId: "external:incoming-1:weak" }]]),
      operationNow: "2026-09-14T00:00:00.000Z", createUuid,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.candidate.contacts.values()]).toEqual([local]);
  });

  it("gives a new contact a fresh local UUID and operationNow timestamps", () => {
    const local = localSnapshot();
    const incomingBackup = backup([contact({ id: "incoming-1", createdAt: "2020-01-01T00:00:00.000Z" })]);
    const preflight = analyzeExternalImport(local, incomingBackup);

    const result = buildExternalImportCandidate({
      latestLocal: local,
      incoming: incomingBackup,
      preflight,
      strategy: "keep_local",
      decisions: new Map(),
      operationNow: "2026-09-14T00:00:00.000Z",
      createUuid,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const created = [...result.candidate.contacts.values()][0];
    expect(created.id).not.toBe("incoming-1");
    expect(created.createdAt).toBe("2026-09-14T00:00:00.000Z");
    expect(created.updatedAt).toBe("2026-09-14T00:00:00.000Z");
    expect(created.identityUpdatedAt).toBe("2026-09-14T00:00:00.000Z");
  });

  it("stable duplicate use_incoming overwrites only nickname/note", () => {
    const local = contact({ id: "local-1", threadsUserId: "123", username: "alice", nickname: "Old", createdAt: "2020-01-01T00:00:00.000Z" });
    const localState = localSnapshot([local]);
    const incomingBackup = backup([contact({ id: "incoming-1", threadsUserId: "123", username: "alice-renamed", nickname: "New" })]);
    const preflight = analyzeExternalImport(localState, incomingBackup, "use_incoming");

    const result = buildExternalImportCandidate({
      latestLocal: localState,
      incoming: incomingBackup,
      preflight,
      strategy: "use_incoming",
      decisions: new Map(),
      operationNow: "2026-09-14T00:00:00.000Z",
      createUuid,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const updated = result.candidate.contacts.get("local-1")!;
    expect(updated.nickname).toBe("New");
    expect(updated.username).toBe("alice"); // not overwritten
    expect(updated.createdAt).toBe("2020-01-01T00:00:00.000Z"); // not overwritten
    expect(updated.threadsUserId).toBe("123"); // not overwritten
    expect(updated.updatedAt).toBe("2026-09-14T00:00:00.000Z");
  });

  it("stable duplicate keep_local leaves the local contact untouched", () => {
    const local = contact({ id: "local-1", threadsUserId: "123", nickname: "Old" });
    const localState = localSnapshot([local]);
    const incomingBackup = backup([contact({ id: "incoming-1", threadsUserId: "123", nickname: "New" })]);
    const preflight = analyzeExternalImport(localState, incomingBackup, "keep_local");

    const result = buildExternalImportCandidate({
      latestLocal: localState,
      incoming: incomingBackup,
      preflight,
      strategy: "keep_local",
      decisions: new Map(),
      operationNow: "2026-09-14T00:00:00.000Z",
      createUuid,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.contacts.get("local-1")).toEqual(local);
  });

  it("weak duplicate may adopt incoming's numeric ID only after explicit confirmation", () => {
    const local = contact({ id: "local-1", username: "alice" });
    const localState = localSnapshot([local]);
    const incomingBackup = backup([contact({ id: "incoming-1", username: "alice", threadsUserId: "123" })]);
    const preflight = analyzeExternalImport(localState, incomingBackup);
    const decisions = new Map<string, ImportReviewDecision>([
      [
        "external:incoming-1:weak",
        { kind: "confirm_weak_identity", itemId: "external:incoming-1:weak", nickname: "Alice", adoptIncomingThreadsUserId: true },
      ],
    ]);

    const result = buildExternalImportCandidate({
      latestLocal: localState,
      incoming: incomingBackup,
      preflight,
      strategy: "review_each",
      decisions,
      operationNow: "2026-09-14T00:00:00.000Z",
      createUuid,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.contacts.get("local-1")?.threadsUserId).toBe("123");
  });

  it("identity mismatch cannot merge - import_as_new creates a separate contact", () => {
    const local = contact({ id: "local-1", username: "alice", threadsUserId: "123" });
    const localState = localSnapshot([local]);
    const incomingBackup = backup([contact({ id: "incoming-1", username: "alice", threadsUserId: "999" })]);
    const preflight = analyzeExternalImport(localState, incomingBackup);
    const decisions = new Map<string, ImportReviewDecision>([
      ["external:incoming-1:mismatch", { kind: "import_as_new", itemId: "external:incoming-1:mismatch" }],
    ]);

    const result = buildExternalImportCandidate({
      latestLocal: localState,
      incoming: incomingBackup,
      preflight,
      strategy: "review_each",
      decisions,
      operationNow: "2026-09-14T00:00:00.000Z",
      createUuid,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.contacts.get("local-1")?.threadsUserId).toBe("123"); // untouched
    expect(result.candidate.contacts.size).toBe(2); // local kept + new contact created
  });

  it("local user_deleted resurrection reuses local UUID and createdAt", () => {
    const tombstone = {
      contactId: "gone-1",
      threadsUserId: "123",
      username: "alice",
      createdAt: "2020-01-01T00:00:00.000Z",
      deletedAt: "2020-06-01T00:00:00.000Z",
      reason: "user_deleted" as const,
    };
    const localState: DirectorySnapshot = {
      directoryId: "local-dir",
      contacts: new Map(),
      tombstones: new Map([["gone-1", tombstone]]),
    };
    const incomingBackup = backup([contact({ id: "incoming-1", threadsUserId: "123", username: "alice" })]);
    const preflight = analyzeExternalImport(localState, incomingBackup);
    const decisions = new Map<string, ImportReviewDecision>([
      ["external:incoming-1:deleted", { kind: "resurrect", itemId: "external:incoming-1:deleted" }],
    ]);

    const result = buildExternalImportCandidate({
      latestLocal: localState,
      incoming: incomingBackup,
      preflight,
      strategy: "review_each",
      decisions,
      operationNow: "2026-09-14T00:00:00.000Z",
      createUuid,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const resurrected = result.candidate.contacts.get("gone-1");
    expect(resurrected?.createdAt).toBe("2020-01-01T00:00:00.000Z");
    expect(result.candidate.tombstones.has("gone-1")).toBe(false);
  });

  it("keeping deleted preserves the tombstone and ignores the incoming record", () => {
    const tombstone = {
      contactId: "gone-1",
      threadsUserId: "123",
      username: "alice",
      createdAt: "2020-01-01T00:00:00.000Z",
      deletedAt: "2020-06-01T00:00:00.000Z",
      reason: "user_deleted" as const,
    };
    const localState: DirectorySnapshot = {
      directoryId: "local-dir",
      contacts: new Map(),
      tombstones: new Map([["gone-1", tombstone]]),
    };
    const incomingBackup = backup([contact({ id: "incoming-1", threadsUserId: "123", username: "alice" })]);
    const preflight = analyzeExternalImport(localState, incomingBackup);
    const decisions = new Map<string, ImportReviewDecision>([
      ["external:incoming-1:deleted", { kind: "keep_deleted", itemId: "external:incoming-1:deleted" }],
    ]);

    const result = buildExternalImportCandidate({
      latestLocal: localState,
      incoming: incomingBackup,
      preflight,
      strategy: "review_each",
      decisions,
      operationNow: "2026-09-14T00:00:00.000Z",
      createUuid,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.tombstones.get("gone-1")).toEqual(tombstone);
    expect(result.candidate.contacts.size).toBe(0);
  });

  it("fails with a missing_decision issue instead of guessing", () => {
    const local = contact({ id: "local-1", username: "alice" });
    const localState = localSnapshot([local]);
    const incomingBackup = backup([contact({ id: "incoming-1", username: "alice" })]);
    const preflight = analyzeExternalImport(localState, incomingBackup);

    const result = buildExternalImportCandidate({
      latestLocal: localState,
      incoming: incomingBackup,
      preflight,
      strategy: "review_each",
      decisions: new Map(),
      operationNow: "2026-09-14T00:00:00.000Z",
      createUuid,
    });

    expect(result).toMatchObject({ ok: false, issues: [{ type: "missing_decision" }] });
  });

  it("a merged tombstone redirects to canonical instead of resurrecting the retired identity (§27)", () => {
    const canonical = contact({ id: "canonical", username: "newalice", threadsUserId: "123", nickname: "Canonical" });
    const merged: ContactTombstone = {
      contactId: "retired",
      username: "oldalice",
      threadsUserId: "123",
      createdAt: "2020-01-01T00:00:00.000Z",
      deletedAt: "2020-06-01T00:00:00.000Z",
      reason: "merged",
      mergedIntoContactId: "canonical",
    };
    const localState = localSnapshot([canonical], [merged]);
    const incomingBackup = backup([contact({ id: "incoming-1", threadsUserId: "123", username: "oldalice", nickname: "Incoming" })]);
    const preflight = analyzeExternalImport(localState, incomingBackup, "use_incoming");

    const result = buildExternalImportCandidate({
      latestLocal: localState,
      incoming: incomingBackup,
      preflight,
      strategy: "use_incoming",
      decisions: new Map(),
      operationNow: "2026-09-14T00:00:00.000Z",
      createUuid,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The merged tombstone is untouched - the retired UUID never comes back.
    expect(result.candidate.tombstones.get("retired")).toEqual(merged);
    expect(result.candidate.contacts.has("retired")).toBe(false);
    // The canonical contact was updated (stable duplicate under use_incoming), not duplicated.
    expect(result.candidate.contacts.size).toBe(1);
    expect(result.candidate.contacts.get("canonical")?.nickname).toBe("Incoming");
    expect(result.candidate.contacts.get("canonical")?.username).toBe("newalice"); // not overwritten
  });

  it("fails closed with a blocking issue when a merged tombstone's canonical cannot be resolved", () => {
    const merged: ContactTombstone = {
      contactId: "retired",
      username: "oldalice",
      threadsUserId: "123",
      createdAt: "2020-01-01T00:00:00.000Z",
      deletedAt: "2020-06-01T00:00:00.000Z",
      reason: "merged",
      mergedIntoContactId: "ghost-canonical",
    };
    const localState = localSnapshot([], [merged]);
    const incomingBackup = backup([contact({ id: "incoming-1", threadsUserId: "123", username: "oldalice" })]);
    const preflight = analyzeExternalImport(localState, incomingBackup);

    const result = buildExternalImportCandidate({
      latestLocal: localState,
      incoming: incomingBackup,
      preflight,
      strategy: "review_each",
      decisions: new Map(),
      operationNow: "2026-09-14T00:00:00.000Z",
      createUuid,
    });

    expect(result).toMatchObject({ ok: false, issues: [{ type: "blocking", issue: { code: "unresolved_merged_lineage" } }] });
  });

  it("does not collide ids between a plain new_contact and an import_as_new decision in the same build", () => {
    const local = contact({ id: "local-1", username: "alice", threadsUserId: "123" });
    const localState = localSnapshot([local]);
    const incomingBackup = backup([
      contact({ id: "incoming-brand-new", username: "brandnew" }),
      contact({ id: "incoming-mismatch", username: "alice", threadsUserId: "999" }),
    ]);
    const preflight = analyzeExternalImport(localState, incomingBackup);
    const decisions = new Map<string, ImportReviewDecision>([
      ["external:incoming-mismatch:mismatch", { kind: "import_as_new", itemId: "external:incoming-mismatch:mismatch" }],
    ]);

    const result = buildExternalImportCandidate({
      latestLocal: localState,
      incoming: incomingBackup,
      preflight,
      strategy: "review_each",
      decisions,
      operationNow: "2026-09-14T00:00:00.000Z",
      createUuid,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // local-1 (untouched) + one for the plain new contact + one for import_as_new = 3 distinct contacts.
    expect(result.candidate.contacts.size).toBe(3);
  });

  it("never arbitrarily picks a winner when two local active contacts already share a stable ID", () => {
    const localA = contact({ id: "local-a", threadsUserId: "123", username: "alice-a", nickname: "A" });
    const localB = contact({ id: "local-b", threadsUserId: "123", username: "alice-b", nickname: "B" });
    const localState = localSnapshot([localA, localB]);
    const incomingBackup = backup([contact({ id: "incoming-1", threadsUserId: "123", username: "alice-renamed" })]);
    const preflight = analyzeExternalImport(localState, incomingBackup, "use_incoming");

    const result = buildExternalImportCandidate({
      latestLocal: localState,
      incoming: incomingBackup,
      preflight,
      strategy: "use_incoming",
      decisions: new Map(),
      operationNow: "2026-09-14T00:00:00.000Z",
      createUuid,
    });

    expect(result).toMatchObject({ ok: false, issues: [{ type: "blocking", issue: { code: "ambiguous_local_identity" } }] });
  });

  it("two incoming contacts matching the same local stable duplicate block instead of the last one silently winning", () => {
    // Exact reproduction from the review: without the fix, use_incoming
    // would apply incoming-a's private data then unconditionally overwrite
    // it with incoming-b's (array order), losing incoming-a's data with no
    // trace. commit must never proceed at all in this state.
    const local = contact({ id: "local-1", threadsUserId: "123", username: "alice", nickname: "Original" });
    const localState = localSnapshot([local]);
    const incomingA = contact({ id: "incoming-a", threadsUserId: "123", username: "alice-a", nickname: "FromA" });
    const incomingB = contact({ id: "incoming-b", threadsUserId: "123", username: "alice-b", nickname: "FromB" });
    const incomingBackup = backup([incomingA, incomingB]);
    const preflight = analyzeExternalImport(localState, incomingBackup, "use_incoming");

    const result = buildExternalImportCandidate({
      latestLocal: localState,
      incoming: incomingBackup,
      preflight,
      strategy: "use_incoming",
      decisions: new Map(),
      operationNow: "2026-09-14T00:00:00.000Z",
      createUuid,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([
      { type: "blocking", issue: { code: "duplicate_import_target", contactId: "local-1", message: expect.any(String) } },
      { type: "blocking", issue: { code: "duplicate_import_target", contactId: "local-1", message: expect.any(String) } },
    ]);
  });

  it("blocks on the duplicate target with the same outcome regardless of incoming array order", () => {
    const local = contact({ id: "local-1", threadsUserId: "123", username: "alice", nickname: "Original" });
    const localState = localSnapshot([local]);
    const incomingA = contact({ id: "incoming-a", threadsUserId: "123", username: "alice-a", nickname: "FromA" });
    const incomingB = contact({ id: "incoming-b", threadsUserId: "123", username: "alice-b", nickname: "FromB" });

    function build(order: ThreadContact[]) {
      const incomingBackup = backup(order);
      const preflight = analyzeExternalImport(localState, incomingBackup, "use_incoming");
      return buildExternalImportCandidate({
        latestLocal: localState,
        incoming: incomingBackup,
        preflight,
        strategy: "use_incoming",
        decisions: new Map(),
        operationNow: "2026-09-14T00:00:00.000Z",
        createUuid,
      });
    }

    const forward = build([incomingA, incomingB]);
    const reversed = build([incomingB, incomingA]);

    expect(forward.ok).toBe(false);
    expect(reversed.ok).toBe(false);
    // Neither order leaves local-1's nickname changed - the import must not commit at all.
    expect(local.nickname).toBe("Original");
  });

  it("two Stable Duplicates targeting the same local under keep_local succeed - neither one writes anything", () => {
    const local = contact({ id: "local-1", threadsUserId: "123", username: "alice", nickname: "Original" });
    const localState = localSnapshot([local]);
    const incomingBackup = backup([
      contact({ id: "incoming-a", threadsUserId: "123", username: "alice-a", nickname: "FromA" }),
      contact({ id: "incoming-b", threadsUserId: "123", username: "alice-b", nickname: "FromB" }),
    ]);
    const preflight = analyzeExternalImport(localState, incomingBackup, "keep_local");

    const result = buildExternalImportCandidate({
      latestLocal: localState,
      incoming: incomingBackup,
      preflight,
      strategy: "keep_local",
      decisions: new Map(),
      operationNow: "2026-09-14T00:00:00.000Z",
      createUuid,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.contacts.get("local-1")).toEqual(local);
    expect(result.candidate.contacts.size).toBe(1);
  });

  it("two Stable Duplicates targeting the same local under review_each, both decided keep_local, succeed", () => {
    const local = contact({ id: "local-1", threadsUserId: "123", username: "alice", nickname: "Original" });
    const localState = localSnapshot([local]);
    const incomingBackup = backup([
      contact({ id: "incoming-a", threadsUserId: "123", username: "alice-a", nickname: "FromA" }),
      contact({ id: "incoming-b", threadsUserId: "123", username: "alice-b", nickname: "FromB" }),
    ]);
    const preflight = analyzeExternalImport(localState, incomingBackup, "review_each");
    const decisions = new Map<string, ImportReviewDecision>([
      ["external:incoming-a:stable", { kind: "keep_local", itemId: "external:incoming-a:stable" }],
      ["external:incoming-b:stable", { kind: "keep_local", itemId: "external:incoming-b:stable" }],
    ]);

    const result = buildExternalImportCandidate({
      latestLocal: localState,
      incoming: incomingBackup,
      preflight,
      strategy: "review_each",
      decisions,
      operationNow: "2026-09-14T00:00:00.000Z",
      createUuid,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.contacts.get("local-1")).toEqual(local);
  });

  it("two Stable Duplicates targeting the same local under review_each, one keep_local and one writes, succeed and only the writing one is applied", () => {
    const local = contact({ id: "local-1", threadsUserId: "123", username: "alice", nickname: "Original" });
    const localState = localSnapshot([local]);
    const incomingBackup = backup([
      contact({ id: "incoming-a", threadsUserId: "123", username: "alice-a", nickname: "FromA" }),
      contact({ id: "incoming-b", threadsUserId: "123", username: "alice-b", nickname: "FromB" }),
    ]);
    const preflight = analyzeExternalImport(localState, incomingBackup, "review_each");
    const decisions = new Map<string, ImportReviewDecision>([
      ["external:incoming-a:stable", { kind: "keep_local", itemId: "external:incoming-a:stable" }],
      ["external:incoming-b:stable", { kind: "use_incoming_private_data", itemId: "external:incoming-b:stable" }],
    ]);

    const result = buildExternalImportCandidate({
      latestLocal: localState,
      incoming: incomingBackup,
      preflight,
      strategy: "review_each",
      decisions,
      operationNow: "2026-09-14T00:00:00.000Z",
      createUuid,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.contacts.get("local-1")!.nickname).toBe("FromB");
    expect(result.candidate.contacts.size).toBe(1);
  });

  it("two Stable Duplicates targeting the same local under review_each, both deciding to write, block regardless of incoming order", () => {
    const local = contact({ id: "local-1", threadsUserId: "123", username: "alice", nickname: "Original" });
    const localState = localSnapshot([local]);
    const incomingA = contact({ id: "incoming-a", threadsUserId: "123", username: "alice-a", nickname: "FromA" });
    const incomingB = contact({ id: "incoming-b", threadsUserId: "123", username: "alice-b", nickname: "FromB" });
    const decisions = new Map<string, ImportReviewDecision>([
      ["external:incoming-a:stable", { kind: "use_incoming_private_data", itemId: "external:incoming-a:stable" }],
      ["external:incoming-b:stable", { kind: "custom_private_data", itemId: "external:incoming-b:stable", nickname: "Custom" }],
    ]);

    function build(order: ThreadContact[]) {
      const incomingBackup = backup(order);
      const preflight = analyzeExternalImport(localState, incomingBackup, "review_each");
      return buildExternalImportCandidate({
        latestLocal: localState,
        incoming: incomingBackup,
        preflight,
        strategy: "review_each",
        decisions,
        operationNow: "2026-09-14T00:00:00.000Z",
        createUuid,
      });
    }

    const forward = build([incomingA, incomingB]);
    const reversed = build([incomingB, incomingA]);

    expect(forward).toMatchObject({ ok: false, issues: [{ type: "blocking", issue: { code: "duplicate_import_target", contactId: "local-1" } }, { type: "blocking", issue: { code: "duplicate_import_target", contactId: "local-1" } }] });
    expect(reversed).toMatchObject({ ok: false, issues: [{ type: "blocking", issue: { code: "duplicate_import_target", contactId: "local-1" } }, { type: "blocking", issue: { code: "duplicate_import_target", contactId: "local-1" } }] });
    expect(local.nickname).toBe("Original");
  });

  it("two Weak Duplicates matching the same local, both import_as_new, succeed and create two new contacts", () => {
    const local = contact({ id: "local-1", username: "alice", nickname: "Original" });
    const localState = localSnapshot([local]);
    const incomingBackup = backup([
      contact({ id: "incoming-a", username: "alice", nickname: "FromA" }),
      contact({ id: "incoming-b", username: "alice", nickname: "FromB" }),
    ]);
    const preflight = analyzeExternalImport(localState, incomingBackup, "review_each");
    const decisions = new Map<string, ImportReviewDecision>([
      ["external:incoming-a:weak", { kind: "import_as_new", itemId: "external:incoming-a:weak" }],
      ["external:incoming-b:weak", { kind: "import_as_new", itemId: "external:incoming-b:weak" }],
    ]);

    const result = buildExternalImportCandidate({
      latestLocal: localState,
      incoming: incomingBackup,
      preflight,
      strategy: "review_each",
      decisions,
      operationNow: "2026-09-14T00:00:00.000Z",
      createUuid,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.contacts.get("local-1")).toEqual(local);
    // local-1 (untouched) + two brand-new contacts = 3.
    expect(result.candidate.contacts.size).toBe(3);
  });

  it("one Weak Duplicate confirmed and another import_as_new against the same local succeed together", () => {
    const local = contact({ id: "local-1", username: "alice", nickname: "Original" });
    const localState = localSnapshot([local]);
    const incomingBackup = backup([
      contact({ id: "incoming-a", username: "alice", nickname: "FromA" }),
      contact({ id: "incoming-b", username: "alice", nickname: "FromB" }),
    ]);
    const preflight = analyzeExternalImport(localState, incomingBackup, "review_each");
    const decisions = new Map<string, ImportReviewDecision>([
      [
        "external:incoming-a:weak",
        { kind: "confirm_weak_identity", itemId: "external:incoming-a:weak", nickname: "Confirmed", adoptIncomingThreadsUserId: false },
      ],
      ["external:incoming-b:weak", { kind: "import_as_new", itemId: "external:incoming-b:weak" }],
    ]);

    const result = buildExternalImportCandidate({
      latestLocal: localState,
      incoming: incomingBackup,
      preflight,
      strategy: "review_each",
      decisions,
      operationNow: "2026-09-14T00:00:00.000Z",
      createUuid,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.contacts.get("local-1")!.nickname).toBe("Confirmed");
    // local-1 (updated) + one brand-new contact from import_as_new = 2.
    expect(result.candidate.contacts.size).toBe(2);
  });

  it("two Weak Duplicates both confirmed against the same local block, regardless of order", () => {
    const local = contact({ id: "local-1", username: "alice", nickname: "Original" });
    const localState = localSnapshot([local]);
    const incomingA = contact({ id: "incoming-a", username: "alice", nickname: "FromA" });
    const incomingB = contact({ id: "incoming-b", username: "alice", nickname: "FromB" });
    const decisions = new Map<string, ImportReviewDecision>([
      [
        "external:incoming-a:weak",
        { kind: "confirm_weak_identity", itemId: "external:incoming-a:weak", nickname: "ConfirmedA", adoptIncomingThreadsUserId: false },
      ],
      [
        "external:incoming-b:weak",
        { kind: "confirm_weak_identity", itemId: "external:incoming-b:weak", nickname: "ConfirmedB", adoptIncomingThreadsUserId: false },
      ],
    ]);

    function build(order: ThreadContact[]) {
      const incomingBackup = backup(order);
      const preflight = analyzeExternalImport(localState, incomingBackup, "review_each");
      return buildExternalImportCandidate({
        latestLocal: localState,
        incoming: incomingBackup,
        preflight,
        strategy: "review_each",
        decisions,
        operationNow: "2026-09-14T00:00:00.000Z",
        createUuid,
      });
    }

    const forward = build([incomingA, incomingB]);
    const reversed = build([incomingB, incomingA]);

    expect(forward.ok).toBe(false);
    expect(reversed.ok).toBe(false);
    expect(local.nickname).toBe("Original");
  });

  it("two Locally Deleted matches against the same tombstone, both kept deleted, succeed", () => {
    const tombstone: ContactTombstone = {
      contactId: "gone-1",
      threadsUserId: "123",
      username: "alice",
      createdAt: "2020-01-01T00:00:00.000Z",
      deletedAt: "2020-06-01T00:00:00.000Z",
      reason: "user_deleted",
    };
    const localState = localSnapshot([], [tombstone]);
    const incomingBackup = backup([
      contact({ id: "incoming-a", threadsUserId: "123", username: "alice-a" }),
      contact({ id: "incoming-b", threadsUserId: "123", username: "alice-b" }),
    ]);
    const preflight = analyzeExternalImport(localState, incomingBackup, "review_each");
    const decisions = new Map<string, ImportReviewDecision>([
      ["external:incoming-a:deleted", { kind: "keep_deleted", itemId: "external:incoming-a:deleted" }],
      ["external:incoming-b:deleted", { kind: "keep_deleted", itemId: "external:incoming-b:deleted" }],
    ]);

    const result = buildExternalImportCandidate({
      latestLocal: localState,
      incoming: incomingBackup,
      preflight,
      strategy: "review_each",
      decisions,
      operationNow: "2026-09-14T00:00:00.000Z",
      createUuid,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.tombstones.get("gone-1")).toEqual(tombstone);
    expect(result.candidate.contacts.size).toBe(0);
  });

  it("two Locally Deleted matches against the same tombstone, both resurrected, block regardless of order", () => {
    const tombstone: ContactTombstone = {
      contactId: "gone-1",
      threadsUserId: "123",
      username: "alice",
      createdAt: "2020-01-01T00:00:00.000Z",
      deletedAt: "2020-06-01T00:00:00.000Z",
      reason: "user_deleted",
    };
    const localState = localSnapshot([], [tombstone]);
    const incomingA = contact({ id: "incoming-a", threadsUserId: "123", username: "alice-a" });
    const incomingB = contact({ id: "incoming-b", threadsUserId: "123", username: "alice-b" });
    const decisions = new Map<string, ImportReviewDecision>([
      ["external:incoming-a:deleted", { kind: "resurrect", itemId: "external:incoming-a:deleted" }],
      ["external:incoming-b:deleted", { kind: "resurrect", itemId: "external:incoming-b:deleted" }],
    ]);

    function build(order: ThreadContact[]) {
      const incomingBackup = backup(order);
      const preflight = analyzeExternalImport(localState, incomingBackup, "review_each");
      return buildExternalImportCandidate({
        latestLocal: localState,
        incoming: incomingBackup,
        preflight,
        strategy: "review_each",
        decisions,
        operationNow: "2026-09-14T00:00:00.000Z",
        createUuid,
      });
    }

    const forward = build([incomingA, incomingB]);
    const reversed = build([incomingB, incomingA]);

    const expectedIssues = [
      { type: "blocking", issue: { code: "duplicate_import_target", contactId: "gone-1" } },
      { type: "blocking", issue: { code: "duplicate_import_target", contactId: "gone-1" } },
    ];
    expect(forward).toMatchObject({ ok: false, issues: expectedIssues });
    expect(reversed).toMatchObject({ ok: false, issues: expectedIssues });
    expect(localState.tombstones.get("gone-1")).toEqual(tombstone);
  });
});
