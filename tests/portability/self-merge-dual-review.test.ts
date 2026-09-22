import { describe, expect, it } from "vitest";

import type { ThreadContact } from "../../src/domain/contact";
import type { DirectorySnapshot } from "../../src/domain/directorySnapshot";
import { analyzeSelfMerge } from "../../src/portability/analyzeImport";
import type { BackupSnapshotV2 } from "../../src/portability/backupTypes";
import { buildSelfMergeCandidate } from "../../src/portability/buildCandidateSnapshot";
import type { ImportReviewDecision } from "../../src/portability/reviewDecisions";

function contact(overrides: Partial<ThreadContact>): ThreadContact {
  return {
    id: "a",
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
    directoryId: "dir-1",
    exportedAt: "2026-02-01T00:00:00.000Z",
    contacts,
    tombstones: [],
  };
}

function snapshot(contacts: ThreadContact[]): DirectorySnapshot {
  return { directoryId: "dir-1", contacts: new Map(contacts.map((c) => [c.id, c])), tombstones: new Map() };
}

// Same contact simultaneously has an equal-timestamp nickname divergence AND
// an equal-timestamp username divergence, with no numeric ID on either side.
function localContact(): ThreadContact {
  return contact({
    id: "a",
    username: "alice-local",
    nickname: "Local Name",
    updatedAt: "2026-01-01T00:00:00.000Z",
    identityUpdatedAt: "2026-01-01T00:00:00.000Z",
  });
}

function incomingContact(): ThreadContact {
  return contact({
    id: "a",
    username: "alice-incoming",
    nickname: "Incoming Name",
    updatedAt: "2026-01-01T00:00:00.000Z",
    identityUpdatedAt: "2026-01-01T00:00:00.000Z",
  });
}

describe("self merge: simultaneous private-data and identity ambiguity on the same contact", () => {
  it("creates two independent review items instead of silently keeping one dimension as local", () => {
    const preflight = analyzeSelfMerge(snapshot([localContact()]), backup([incomingContact()]));

    expect(preflight.items).toEqual(
      expect.arrayContaining([
        { itemId: "contact:a:private", contactId: "a", kind: "review_private_data", requiresDecision: true },
        { itemId: "contact:a:identity", contactId: "a", kind: "review_identity_snapshot", requiresDecision: true },
      ]),
    );
    expect(preflight.items).toHaveLength(2);
    expect(preflight.summary.ambiguous).toBe(2);
  });

  it("build fails with two missing_decision issues when neither review has been decided", () => {
    const local = snapshot([localContact()]);
    const incoming = backup([incomingContact()]);
    const preflight = analyzeSelfMerge(local, incoming);

    const result = buildSelfMergeCandidate({
      latestLocal: local,
      incoming,
      preflight,
      decisions: new Map(),
      operationNow: "2026-09-14T00:00:00.000Z",
    });

    expect(result).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        { type: "missing_decision", itemId: "contact:a:private" },
        { type: "missing_decision", itemId: "contact:a:identity" },
      ]),
    });
  });

  it("applies both decisions independently: choosing incoming identity does not silently discard the private-data decision", () => {
    const local = snapshot([localContact()]);
    const incoming = backup([incomingContact()]);
    const preflight = analyzeSelfMerge(local, incoming);

    const decisions = new Map<string, ImportReviewDecision>([
      ["contact:a:identity", { kind: "choose_identity_snapshot", itemId: "contact:a:identity", source: "incoming" }],
      ["contact:a:private", { kind: "custom_private_data", itemId: "contact:a:private", nickname: "Both Chose This", note: undefined }],
    ]);

    const result = buildSelfMergeCandidate({
      latestLocal: local,
      incoming,
      preflight,
      decisions,
      operationNow: "2026-09-14T00:00:00.000Z",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const finalContact = result.candidate.contacts.get("a")!;
    expect(finalContact.username).toBe("alice-incoming");
    expect(finalContact.nickname).toBe("Both Chose This");
  });

  it("fails (does not guess) when only the identity decision is provided and private data is still undecided", () => {
    const local = snapshot([localContact()]);
    const incoming = backup([incomingContact()]);
    const preflight = analyzeSelfMerge(local, incoming);

    const decisions = new Map<string, ImportReviewDecision>([
      ["contact:a:identity", { kind: "choose_identity_snapshot", itemId: "contact:a:identity", source: "local" }],
    ]);

    const result = buildSelfMergeCandidate({
      latestLocal: local,
      incoming,
      preflight,
      decisions,
      operationNow: "2026-09-14T00:00:00.000Z",
    });

    expect(result).toMatchObject({ ok: false, issues: [{ type: "missing_decision", itemId: "contact:a:private" }] });
  });
});
