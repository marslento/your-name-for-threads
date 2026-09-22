import { describe, expect, it } from "vitest";

import type { ThreadContact } from "../../src/domain/contact";
import type { ContactTombstone } from "../../src/domain/tombstone";
import type { DirectorySnapshot } from "../../src/domain/directorySnapshot";
import { buildExternalMatchIndexes, classifyExternalContact, findDuplicateTargets } from "../../src/portability/externalMatching";

function contact(overrides: Partial<ThreadContact>): ThreadContact {
  return {
    id: overrides.id ?? "local-1",
    username: "alice",
    nickname: "Alice",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    identityUpdatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function localSnapshot(input: { contacts?: ThreadContact[]; tombstones?: ContactTombstone[] }): DirectorySnapshot {
  return {
    directoryId: "local-dir",
    contacts: new Map((input.contacts ?? []).map((c) => [c.id, c])),
    tombstones: new Map((input.tombstones ?? []).map((t) => [t.contactId, t])),
  };
}

function mergedTombstone(overrides: Partial<ContactTombstone> = {}): ContactTombstone {
  return {
    contactId: "retired",
    username: "oldalice",
    threadsUserId: "123",
    createdAt: "2026-01-01T00:00:00.000Z",
    deletedAt: "2026-01-02T00:00:00.000Z",
    reason: "merged",
    mergedIntoContactId: "canonical",
    ...overrides,
  };
}

describe("classifyExternalContact", () => {
  it("classifies a stable duplicate by matching threadsUserId", () => {
    const local = contact({ id: "local-1", threadsUserId: "123", username: "alice" });
    const indexes = buildExternalMatchIndexes(localSnapshot({ contacts: [local] }));
    const incoming = contact({ id: "incoming-1", threadsUserId: "123", username: "alice-renamed" });

    expect(classifyExternalContact(incoming, indexes)).toEqual({ kind: "stable_duplicate", incoming, local });
  });

  it("classifies a weak duplicate by username fallback only", () => {
    const local = contact({ id: "local-1", username: "alice" });
    const indexes = buildExternalMatchIndexes(localSnapshot({ contacts: [local] }));
    const incoming = contact({ id: "incoming-1", username: "alice" });

    expect(classifyExternalContact(incoming, indexes)).toEqual({ kind: "weak_duplicate", incoming, local });
  });

  it("classifies an identity mismatch when username matches but both numeric IDs differ", () => {
    const local = contact({ id: "local-1", username: "alice", threadsUserId: "123" });
    const indexes = buildExternalMatchIndexes(localSnapshot({ contacts: [local] }));
    const incoming = contact({ id: "incoming-1", username: "alice", threadsUserId: "999" });

    expect(classifyExternalContact(incoming, indexes)).toEqual({ kind: "identity_mismatch", incoming, local });
  });

  it("classifies as locally deleted when a user_deleted tombstone matches threadsUserId", () => {
    const tombstone = {
      contactId: "gone-1",
      threadsUserId: "123",
      username: "alice",
      createdAt: "2026-01-01T00:00:00.000Z",
      deletedAt: "2026-01-02T00:00:00.000Z",
      reason: "user_deleted" as const,
    };
    const indexes = buildExternalMatchIndexes(localSnapshot({ tombstones: [tombstone] }));
    const incoming = contact({ id: "incoming-1", threadsUserId: "123", username: "alice" });

    expect(classifyExternalContact(incoming, indexes)).toEqual({ kind: "locally_deleted", incoming, tombstone });
  });

  it("classifies as new contact when nothing matches", () => {
    const indexes = buildExternalMatchIndexes(localSnapshot({}));
    const incoming = contact({ id: "incoming-1", username: "brandnew" });

    expect(classifyExternalContact(incoming, indexes)).toEqual({ kind: "new_contact", incoming });
  });

  it("a merged tombstone is never a resurrection candidate - it redirects to the canonical contact instead (§27)", () => {
    // Same scenario as the Phase 3 §27 walkthrough: a retired duplicate UUID
    // ("retired", now merged into "canonical") shares canonical's stable ID.
    const canonical = contact({ id: "canonical", username: "newalice", threadsUserId: "123" });
    const merged = mergedTombstone();
    const indexes = buildExternalMatchIndexes(localSnapshot({ contacts: [canonical], tombstones: [merged] }));

    const incomingSameId = contact({ id: "incoming-1", threadsUserId: "123", username: "oldalice" });
    expect(classifyExternalContact(incomingSameId, indexes)).toEqual({
      kind: "stable_duplicate",
      incoming: incomingSameId,
      local: canonical,
    });
  });

  it("matching a merged tombstone by its old (retired) username redirects to canonical as a weak duplicate when incoming has no numeric ID", () => {
    const canonical = contact({ id: "canonical", username: "newalice", threadsUserId: "123" });
    const merged = mergedTombstone({ threadsUserId: undefined });
    const indexes = buildExternalMatchIndexes(localSnapshot({ contacts: [canonical], tombstones: [merged] }));

    const incoming = contact({ id: "incoming-1", username: "oldalice" });
    expect(classifyExternalContact(incoming, indexes)).toEqual({ kind: "weak_duplicate", incoming, local: canonical });
  });

  it("an incoming numeric ID that differs from the canonical's is an identity mismatch, not a merge", () => {
    const canonical = contact({ id: "canonical", username: "newalice", threadsUserId: "123" });
    const merged = mergedTombstone();
    const indexes = buildExternalMatchIndexes(localSnapshot({ contacts: [canonical], tombstones: [merged] }));

    const incoming = contact({ id: "incoming-1", threadsUserId: "999", username: "oldalice" });
    expect(classifyExternalContact(incoming, indexes)).toEqual({ kind: "identity_mismatch", incoming, local: canonical });
  });

  it("reports a broken merged lineage when the canonical contact cannot be resolved, instead of guessing", () => {
    const merged = mergedTombstone({ mergedIntoContactId: "ghost-canonical" });
    const indexes = buildExternalMatchIndexes(localSnapshot({ tombstones: [merged] }));

    const incoming = contact({ id: "incoming-1", threadsUserId: "123", username: "oldalice" });
    expect(classifyExternalContact(incoming, indexes)).toEqual({ kind: "broken_merged_lineage", incoming, tombstone: merged });
  });

  it("never arbitrarily picks a winner when two local active contacts already share a stable ID (unresolved Phase 2 conflict)", () => {
    // Two local contacts already share threadsUserId "123" - a legitimate,
    // already-supported Phase 2 pending-conflict state. External import must
    // not silently decide which one the incoming record matches.
    const localA = contact({ id: "local-a", threadsUserId: "123", username: "alice-a" });
    const localB = contact({ id: "local-b", threadsUserId: "123", username: "alice-b" });
    const indexes = buildExternalMatchIndexes(localSnapshot({ contacts: [localA, localB] }));
    const incoming = contact({ id: "incoming-1", threadsUserId: "123", username: "alice-renamed" });

    const match = classifyExternalContact(incoming, indexes);

    expect(match.kind).toBe("ambiguous_local_identity");
  });

  it("reports the same ambiguity regardless of which local contact was inserted first", () => {
    const localA = contact({ id: "local-a", threadsUserId: "123", username: "alice-a" });
    const localB = contact({ id: "local-b", threadsUserId: "123", username: "alice-b" });
    const incoming = contact({ id: "incoming-1", threadsUserId: "123", username: "alice-renamed" });

    const forward = buildExternalMatchIndexes(localSnapshot({ contacts: [localA, localB] }));
    const reversed = buildExternalMatchIndexes(localSnapshot({ contacts: [localB, localA] }));

    expect(classifyExternalContact(incoming, forward).kind).toBe("ambiguous_local_identity");
    expect(classifyExternalContact(incoming, reversed).kind).toBe("ambiguous_local_identity");
  });

  it("never arbitrarily picks a winner when two local active contacts share a normalized username", () => {
    const localA = contact({ id: "local-a", username: "alice" });
    const localB = contact({ id: "local-b", username: "alice" });
    const indexes = buildExternalMatchIndexes(localSnapshot({ contacts: [localA, localB] }));
    const incoming = contact({ id: "incoming-1", username: "alice" });

    expect(classifyExternalContact(incoming, indexes).kind).toBe("ambiguous_local_identity");
  });

  it("stays unambiguous when only one local contact holds a given stable ID", () => {
    const local = contact({ id: "local-1", threadsUserId: "123", username: "alice" });
    const indexes = buildExternalMatchIndexes(localSnapshot({ contacts: [local] }));
    const incoming = contact({ id: "incoming-1", threadsUserId: "123", username: "alice-renamed" });

    expect(classifyExternalContact(incoming, indexes)).toEqual({ kind: "stable_duplicate", incoming, local });
  });
});

describe("findDuplicateTargets", () => {
  // A pure counting utility now (Phase 3 review round 4): "what a match
  // would actually write to" depends on strategy/decision, not the match
  // kind alone, so resolving targets is the caller's job (see
  // analyzeExternalImport's preflightWriteTarget and
  // buildCandidateSnapshot's resolveExternalMatchWriteTarget) - this just
  // flags which of the resolved targets repeat.

  it("flags a target that appears more than once", () => {
    expect(findDuplicateTargets(["local-1", "local-1"])).toEqual(new Set(["local-1"]));
  });

  it("flags the same duplicate regardless of array order", () => {
    expect(findDuplicateTargets(["local-1", "local-2", "local-1"])).toEqual(new Set(["local-1"]));
    expect(findDuplicateTargets(["local-1", "local-1", "local-2"])).toEqual(new Set(["local-1"]));
  });

  it("ignores null entries (matches that resolve to no write target)", () => {
    expect(findDuplicateTargets([null, null, "local-1"])).toEqual(new Set());
  });

  it("does not flag anything when every target is distinct", () => {
    expect(findDuplicateTargets(["local-a", "local-b"])).toEqual(new Set());
  });
});
