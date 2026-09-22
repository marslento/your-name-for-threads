import type { ThreadContact } from "../domain/contact";
import type { ContactTombstone } from "../domain/tombstone";

/**
 * The relationship between a backup and the current Directory - decided
 * before any operation is (Phase 3.6 §5). See `classifyImportLineage`.
 */
export type ImportLineage = "same_lineage" | "adoptable_lineage" | "different_lineage";

/**
 * The operation itself. "restore" is snapshot replacement (Phase 3.6 §7):
 * the backup wins as a whole, with no per-record timestamp comparison and
 * no Review queue. "self_merge" is union + reconciliation (§10): the newer
 * lifecycle/record state wins, local-only contacts survive, and a newer
 * local deletion is preserved. "external_import" treats the incoming data
 * as foreign (§16): the current Directory keeps its own lineage.
 */
export type ImportMode = "restore" | "self_merge" | "external_import";

export type ImportBlockingIssueCode =
  | "stable_identity_contradiction"
  | "merged_lineage_conflict"
  | "unresolved_merged_lineage"
  | "ambiguous_local_identity"
  | "duplicate_import_target";

export interface ImportBlockingIssue {
  code: ImportBlockingIssueCode;
  contactId: string;
  message: string;
}

export type SelfMergeReviewKind =
  | "active_active_private_data"
  | "active_active_identity_snapshot"
  | "active_tombstone_lifecycle"
  | "tombstone_tombstone_lifecycle";

export interface SelfMergeReviewIssue {
  kind: SelfMergeReviewKind;
  contactId: string;
}

/**
 * The generic shape every Self Merge pairwise decision resolves to (Phase 3
 * §66's table-driven merge tests target this type directly).
 */
export type SelfMergeResolution<T> =
  | { kind: "resolved"; value: T }
  | { kind: "review"; issue: SelfMergeReviewIssue }
  | { kind: "blocking"; issue: ImportBlockingIssue };

export type SelfMergeRecordSide =
  | { type: "active"; contact: ThreadContact }
  | { type: "tombstone"; tombstone: ContactTombstone };

export type SelfMergeRecordResolution =
  | { kind: "resolved"; result: SelfMergeRecordSide }
  | { kind: "review"; issue: SelfMergeReviewIssue }
  | { kind: "blocking"; issue: ImportBlockingIssue };

export type ExternalDuplicateStrategy = "keep_local" | "use_incoming" | "review_each";

export type ExternalMatchKind =
  | "stable_duplicate"
  | "weak_duplicate"
  | "identity_mismatch"
  | "locally_deleted"
  | "new_contact"
  | "broken_merged_lineage"
  | "ambiguous_local_identity";

export interface StableDuplicateMatch {
  kind: "stable_duplicate";
  incoming: ThreadContact;
  local: ThreadContact;
}

export interface WeakDuplicateMatch {
  kind: "weak_duplicate";
  incoming: ThreadContact;
  local: ThreadContact;
}

export interface IdentityMismatchMatch {
  kind: "identity_mismatch";
  incoming: ThreadContact;
  local: ThreadContact;
}

export interface LocallyDeletedMatch {
  kind: "locally_deleted";
  incoming: ThreadContact;
  tombstone: ContactTombstone;
}

export interface NewContactMatch {
  kind: "new_contact";
  incoming: ThreadContact;
}

/** The incoming record's stable ID or username hits a `merged` tombstone, but `mergedIntoContactId` no longer resolves to an active contact (Phase 3 §27). */
export interface BrokenMergedLineageMatch {
  kind: "broken_merged_lineage";
  incoming: ThreadContact;
  tombstone: ContactTombstone;
}

/**
 * The incoming record's stable ID or username matches more than one local
 * record (active contact, tombstone, or merge lineage) - e.g. a pending
 * Phase 2 identity conflict where two active contacts already share a
 * `threadsUserId`. There is no single correct local target to match
 * against, so this must never be resolved by arbitrarily picking one
 * (Phase 3 review round 3, High #2).
 */
export interface AmbiguousLocalIdentityMatch {
  kind: "ambiguous_local_identity";
  incoming: ThreadContact;
  reason: string;
}

export type ExternalMatch =
  | StableDuplicateMatch
  | WeakDuplicateMatch
  | IdentityMismatchMatch
  | LocallyDeletedMatch
  | NewContactMatch
  | BrokenMergedLineageMatch
  | AmbiguousLocalIdentityMatch;

/**
 * One row in a Preflight/Review list. `itemId` is the review-decision key;
 * a single contactId can produce more than one item (e.g. a self-merge
 * active/active pair can independently need a private-data review AND an
 * identity-snapshot review), so itemId always disambiguates by dimension.
 */
export type ImportPreflightItemKind =
  | "create"
  | "update"
  | "delete"
  | "unchanged"
  | "review_private_data"
  | "review_identity_snapshot"
  | "review_lifecycle"
  | "external_new"
  | "external_stable_duplicate"
  | "external_weak_duplicate"
  | "external_identity_mismatch"
  | "external_locally_deleted";

export interface ImportPreflightItem {
  itemId: string;
  contactId: string;
  kind: ImportPreflightItemKind;
  requiresDecision: boolean;
}

export interface ImportPreflightSummary {
  create: number;
  update: number;
  delete: number;
  unchanged: number;

  /**
   * Merge only (Phase 3.6 §14): the record exists on both sides and differs,
   * and the local version won on recency. Kept apart from `unchanged`
   * because "your newer edit was preserved" and "neither side had anything
   * to say" look identical in the final Directory but are very different
   * answers to "what will this import do".
   */
  keptLocalNewer: number;
  /** Merge only (Phase 3.6 §12/§14): the backup still has the contact active, but it was deleted locally after the backup was taken, and that deletion is newer. */
  keptLocalDeletion: number;

  stableDuplicates: number;
  weakDuplicates: number;
  identityMismatches: number;
  locallyDeleted: number;

  ambiguous: number;
  pendingIdentityConflictsAfterImport: number;
}

export interface ImportPreflight {
  mode: ImportMode;

  backup: {
    exportedAt: string;
    contactCount: number;
    tombstoneCount: number;
  };

  summary: ImportPreflightSummary;

  items: ImportPreflightItem[];

  blockingIssues: ImportBlockingIssue[];
}
