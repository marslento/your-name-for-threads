import { describe, expect, it } from "vitest";

import type { ContactTombstone } from "../../src/domain/tombstone";
import type { DirectorySnapshot } from "../../src/domain/directorySnapshot";
import type { ImportPreflightItem } from "../../src/portability/importTypes";
import { countKeptDeleted, summarizeCandidateDiff } from "../../src/portability/importSummary";
import type { ImportReviewDecision } from "../../src/portability/reviewDecisions";

describe("summarizeCandidateDiff", () => {
  it("counts an incoming-only tombstone as created", () => {
    const before: DirectorySnapshot = { directoryId: "d", contacts: new Map(), tombstones: new Map() };
    const tombstone: ContactTombstone = {
      contactId: "a",
      username: "alice",
      createdAt: "2026-01-01T00:00:00.000Z",
      deletedAt: "2026-01-02T00:00:00.000Z",
      reason: "user_deleted",
    };
    const after: DirectorySnapshot = { directoryId: "d", contacts: new Map(), tombstones: new Map([["a", tombstone]]) };

    expect(summarizeCandidateDiff(before, after).created).toBe(1);
  });

  it("reports keptDeleted as its own category and excludes it from skipped", () => {
    const snapshot: DirectorySnapshot = { directoryId: "d", contacts: new Map(), tombstones: new Map() };

    const result = summarizeCandidateDiff(snapshot, snapshot, { incomingContactCount: 3, keptDeleted: 1 });

    expect(result.keptDeleted).toBe(1);
    // 3 incoming - 0 created/updated/resurrected - 1 keptDeleted = 2, not 3.
    expect(result.skipped).toBe(2);
  });

  it("counts an untouched record as unchanged, but never twice for a kept-deleted one", () => {
    const tombstone: ContactTombstone = {
      contactId: "gone",
      username: "gone",
      createdAt: "2026-01-01T00:00:00.000Z",
      deletedAt: "2026-01-02T00:00:00.000Z",
      reason: "user_deleted",
    };
    const snapshot: DirectorySnapshot = {
      directoryId: "d",
      contacts: new Map(),
      tombstones: new Map([["gone", tombstone]]),
    };

    expect(summarizeCandidateDiff(snapshot, snapshot).unchanged).toBe(1);
    // Kept deleted has a line of its own, so it must not be counted again
    // under "unchanged" in the same summary.
    expect(summarizeCandidateDiff(snapshot, snapshot, { keptDeleted: 1 }).unchanged).toBe(0);
  });

  it("defaults keptDeleted to 0 when not provided", () => {
    const snapshot: DirectorySnapshot = { directoryId: "d", contacts: new Map(), tombstones: new Map() };

    const result = summarizeCandidateDiff(snapshot, snapshot, { incomingContactCount: 2 });

    expect(result.keptDeleted).toBe(0);
    expect(result.skipped).toBe(2);
  });
});

describe("countKeptDeleted", () => {
  function item(overrides: Partial<ImportPreflightItem>): ImportPreflightItem {
    return {
      itemId: "external:incoming-1:deleted",
      contactId: "gone-1",
      kind: "external_locally_deleted",
      requiresDecision: true,
      ...overrides,
    };
  }

  it("counts a locally-deleted item decided as keep_deleted", () => {
    const items = [item({})];
    const decisions = new Map<string, ImportReviewDecision>([
      ["external:incoming-1:deleted", { kind: "keep_deleted", itemId: "external:incoming-1:deleted" }],
    ]);

    expect(countKeptDeleted(items, decisions)).toBe(1);
  });

  it("does not count a locally-deleted item decided as resurrect", () => {
    const items = [item({})];
    const decisions = new Map<string, ImportReviewDecision>([
      ["external:incoming-1:deleted", { kind: "resurrect", itemId: "external:incoming-1:deleted" }],
    ]);

    expect(countKeptDeleted(items, decisions)).toBe(0);
  });

  it("does not count non-locally-deleted item kinds even if some decision matches by id", () => {
    const items = [item({ kind: "external_new", itemId: "external:incoming-1:new" })];
    const decisions = new Map<string, ImportReviewDecision>([
      ["external:incoming-1:new", { kind: "keep_deleted", itemId: "external:incoming-1:new" } as ImportReviewDecision],
    ]);

    expect(countKeptDeleted(items, decisions)).toBe(0);
  });

  it("counts multiple keep_deleted decisions across items", () => {
    const items = [
      item({ itemId: "external:a:deleted", contactId: "a" }),
      item({ itemId: "external:b:deleted", contactId: "b" }),
    ];
    const decisions = new Map<string, ImportReviewDecision>([
      ["external:a:deleted", { kind: "keep_deleted", itemId: "external:a:deleted" }],
      ["external:b:deleted", { kind: "keep_deleted", itemId: "external:b:deleted" }],
    ]);

    expect(countKeptDeleted(items, decisions)).toBe(2);
  });
});
