import type { ThreadContact } from "../../domain/contact";
import type { ContactTombstone } from "../../domain/tombstone";
import type { DirectoryRecord } from "../../domain/directory";
import type { DirectorySnapshot } from "../../domain/directorySnapshot";
import { reconcileIdentityDerivedState } from "../../domain/identityReconciliation";
import { buildSessionCandidate, type CandidateBuildIssue } from "../../portability/buildCandidateSnapshot";
import { checkImportConcurrency } from "../../portability/importConcurrency";
import { availableImportModes, classifyImportLineage } from "../../portability/importModes";
import type { ImportSession } from "../../portability/importSession";
import { countKeptDeleted, summarizeCandidateDiff, type ImportDiffSummary } from "../../portability/importSummary";
import { validateCandidateSnapshot, type CandidateValidationIssue } from "../../portability/validateCandidate";
import type { DirectoryMutationOutcome } from "../../storage/directoryAccess";
import type { DirectoryRepository } from "../../storage/DirectoryRepository";

export interface ExecuteImportSummary extends ImportDiffSummary {
  pendingIdentityConflictCount: number;
}

export type ExecuteImportOutcome =
  | { status: "success"; result: ExecuteImportSummary }
  | { status: "concurrency_conflict"; reason: string }
  | { status: "build_failed"; issues: CandidateBuildIssue[] }
  | { status: "invalid_candidate"; issues: CandidateValidationIssue[] }
  | { status: "cancelled" }
  | { status: "commit_failed" };

function toSnapshot(directoryId: string, contacts: Record<string, ThreadContact>, tombstones: Record<string, ContactTombstone>): DirectorySnapshot {
  return { directoryId, contacts: new Map(Object.entries(contacts)), tombstones: new Map(Object.entries(tombstones)) };
}

/**
 * The one place the full Phase 3 commit sequence runs end to end (Phase 3
 * §13/§52): check relevant-record concurrency, mint one operation
 * timestamp, rebuild the candidate from scratch, validate it, reconcile
 * identity-derived state, then a single repository commit.
 *
 * The whole sequence runs INSIDE `commitOwnerDirectory`'s `mutate` callback,
 * against the `current` it hands back - not an earlier, unlocked read
 * (Phase 3.5 review round 4, High #5): the cross-context Directory lock is
 * only actually held once `mutate` runs, so checking concurrency before
 * that point can miss a write another context makes in the gap, silently
 * overwriting it. `current.directoryId` is `""` for a never-created owner,
 * matching the placeholder `session.localBaseline`/`concurrencyBaseline`
 * were built with at session-build time - so the concurrency check still
 * compares like with like.
 */
export async function executeImport(input: {
  signal?: AbortSignal;
  ownerThreadsUserId: string;
  session: ImportSession;
  repository: DirectoryRepository;
  clock: () => string;
  createUuid: () => string;
}): Promise<ExecuteImportOutcome> {
  try {
    return await input.repository.commitOwnerDirectory<ExecuteImportOutcome>({
      ownerThreadsUserId: input.ownerThreadsUserId,
      createDirectoryId: input.createUuid,
      // Restore is the only import mode that can adopt a different
      // directoryId (Phase 3.5 Task 36, Phase 3.6 §22) - an "adoptable
      // lineage" restore, where the current account has no Directory data
      // of its own. The directoryId it abandons was pristine by definition
      // (that is what made the lineage adoptable), so deleting it once
      // nothing else is bound to it loses nothing. A same-lineage restore
      // (§6) adopts the id it already has, so this is a no-op for it.
      deleteAbandonedDirectoryIfUnshared: input.session.mode === "restore",
      mutate: (current): DirectoryMutationOutcome<ExecuteImportOutcome> => {
        input.signal?.throwIfAborted();
        const latestLocal = toSnapshot(current.directoryId, current.contacts, current.tombstones);
        const identityConflicts = current.identityConflicts;

        // The operation is re-decided against the Directory as it is under
        // the lock, not as it was when the session was built (Phase 3.6
        // §5/§23, review round 7 High #1). A session whose mode the current
        // relationship no longer offers - most dangerously a Restore chosen
        // while the Directory was still empty, now facing a populated one on
        // a different lineage - is refused here rather than allowed to
        // replace data it was never entitled to touch. The user's way
        // forward is the same one the concurrency check offers: re-analyze,
        // which re-derives both relationship and operation.
        const lineageNow = classifyImportLineage(
          latestLocal,
          Object.keys(identityConflicts).length,
          { directoryId: input.session.source.directoryId, exportedByThreadsUserId: input.session.source.exportedBy.threadsUserId },
          input.ownerThreadsUserId,
        );
        if (!availableImportModes(lineageNow).includes(input.session.mode)) {
          return { write: false, result: { status: "concurrency_conflict", reason: "operation_no_longer_available" } };
        }

        const concurrency = checkImportConcurrency(
          input.session.concurrencyBaseline,
          latestLocal,
          input.session.source,
        );
        if (!concurrency.ok) {
          return { write: false, result: { status: "concurrency_conflict", reason: concurrency.reason } };
        }

        const operationNow = input.clock();
        const buildResult = buildSessionCandidate(input.session, latestLocal, operationNow, input.createUuid);
        if (!buildResult.ok) {
          return { write: false, result: { status: "build_failed", issues: buildResult.issues } };
        }

        // A never-created owner has no real directoryId yet - `latestLocal`
        // (and so `buildResult.candidate`, for Self Merge/External Import,
        // which both just carry it through unchanged) uses "" purely as a
        // placeholder. Only Restore's candidate ever has a real id here (it
        // always adopts the backup's own). Minting the real
        // directoryId only now, at the point a write is actually happening,
        // is what lets a never-created owner reach External Import at all
        // (Phase 3.5 Task 37, e.g. an owner-mismatch backup) without every
        // such owner colliding on the same "" storage key - and it must
        // happen before validation, which itself rejects a blank
        // directoryId.
        const finalDirectoryId = buildResult.candidate.directoryId || input.createUuid();

        const candidateValidation = validateCandidateSnapshot({ ...buildResult.candidate, directoryId: finalDirectoryId });
        if (!candidateValidation.ok) {
          return { write: false, result: { status: "invalid_candidate", issues: candidateValidation.issues } };
        }

        const existingConflicts = new Map(Object.entries(identityConflicts));
        const reconciliation = reconcileIdentityDerivedState({
          contacts: buildResult.candidate.contacts,
          existingConflicts,
          now: operationNow,
        });

        const record: DirectoryRecord = {
          ...current,
          directoryId: finalDirectoryId,
          contacts: Object.fromEntries(buildResult.candidate.contacts),
          tombstones: Object.fromEntries(buildResult.candidate.tombstones),
          identityIndex: reconciliation.identityIndex,
          identityConflicts: reconciliation.identityConflicts,
        };

        const diff = summarizeCandidateDiff(latestLocal, buildResult.candidate, {
          incomingContactCount: input.session.mode === "external_import" ? input.session.source.contacts.length : undefined,
          keptDeleted:
            input.session.mode === "external_import"
              ? countKeptDeleted(input.session.preflight.items, input.session.reviewDecisions)
              : undefined,
        });

        return {
          write: true,
          record,
          result: {
            status: "success",
            result: { ...diff, pendingIdentityConflictCount: Object.keys(reconciliation.identityConflicts).length },
          },
        };
      },
    });
  } catch (error) {
    // AbortSignal's exception may come from a different DOM realm.
    if (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError") return { status: "cancelled" };
    return { status: "commit_failed" };
  }
}
