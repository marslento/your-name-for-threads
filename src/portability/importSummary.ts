import type { DirectorySnapshot } from "../domain/directorySnapshot";
import { contactsEqual, tombstonesEqual } from "./analyzeImport";
import type { ImportPreflightItem } from "./importTypes";
import type { ImportReviewDecision } from "./reviewDecisions";

export interface ImportDiffSummary {
  created: number;
  updated: number;
  resurrected: number;
  deleted: number;
  keptDeleted: number;
  skipped: number;
  unchanged: number;
}

export interface SummarizeCandidateDiffOptions {
  incomingContactCount?: number;
  keptDeleted?: number;
}

/**
 * The single pure function every "what will/did this import do" display
 * uses - the final confirmation preview, the actual execution result, and
 * the Result page all call this against a before/after `DirectorySnapshot`
 * pair, so their numbers can never drift apart. A record that exists only
 * on the `after` side is "created" regardless of whether it lands as an
 * active contact or a tombstone (e.g. self merge adopting a purely-incoming
 * tombstone as deletion history) - both are new to `before`.
 */
export function summarizeCandidateDiff(
  before: DirectorySnapshot,
  after: DirectorySnapshot,
  options: SummarizeCandidateDiffOptions = {},
): ImportDiffSummary {
  let created = 0;
  let updated = 0;
  let resurrected = 0;
  let deleted = 0;
  let unchanged = 0;

  const allIds = new Set([
    ...before.contacts.keys(),
    ...before.tombstones.keys(),
    ...after.contacts.keys(),
    ...after.tombstones.keys(),
  ]);

  for (const id of allIds) {
    const beforeActive = before.contacts.get(id);
    const beforeTombstone = before.tombstones.get(id);
    const afterActive = after.contacts.get(id);
    const afterTombstone = after.tombstones.get(id);
    const existedBefore = Boolean(beforeActive || beforeTombstone);

    if (!existedBefore && (afterActive || afterTombstone)) {
      created += 1;
    } else if (existedBefore && !afterActive && !afterTombstone) {
      // Gone from the Directory entirely, not tombstoned - only Restore
      // produces this (snapshot replacement drops whatever the backup does
      // not contain, Phase 3.6 §7/§11). Merge and External Import never
      // remove a record, so this branch is inert for them.
      deleted += 1;
    } else if (beforeTombstone && afterActive) {
      resurrected += 1;
    } else if (beforeActive && afterTombstone) {
      deleted += 1;
    } else if (beforeActive && afterActive && !contactsEqual(beforeActive, afterActive)) {
      updated += 1;
    } else if (beforeTombstone && afterTombstone && !tombstonesEqual(beforeTombstone, afterTombstone)) {
      updated += 1;
    } else {
      unchanged += 1;
    }
  }

  const keptDeleted = options.keptDeleted ?? 0;
  const skipped =
    options.incomingContactCount === undefined
      ? 0
      : Math.max(0, options.incomingContactCount - (created + updated + resurrected + keptDeleted));

  return {
    created,
    updated,
    resurrected,
    deleted,
    keptDeleted,
    skipped,
    // Kept-deleted records are untouched too, but they already have a line
    // of their own - counting them here as well would show the same record
    // twice in one summary.
    unchanged: Math.max(0, unchanged - keptDeleted),
  };
}

/**
 * "Kept deleted" (Phase 3 §60/§61) is its own outcome category, distinct
 * from "skipped" - reuses the preflight items/decisions already computed
 * for the session rather than re-deriving external-match classification
 * here, so this can never disagree with what `buildExternalImportCandidate`
 * actually decided for the same item.
 */
export function countKeptDeleted(
  items: readonly ImportPreflightItem[],
  decisions: ReadonlyMap<string, ImportReviewDecision>,
): number {
  let count = 0;
  for (const item of items) {
    if (item.kind !== "external_locally_deleted") continue;
    if (decisions.get(item.itemId)?.kind === "keep_deleted") count += 1;
  }
  return count;
}
