import type { ClearAccountDirectoryResult } from "../domain/clearAccountDirectory";
import type { DirectoryRecord } from "../domain/directory";
import type { ResetDirectoryResult } from "../domain/resetDirectory";
import type { DirectoryMutationOutcome } from "./directoryAccess";

/**
 * The portability domain's persistence boundary (Phase 3 §51, Phase 3.5
 * Task 6): every method is explicit about which owner's Directory it acts
 * on. It never accepts settings/identityCache, so a commit can never write
 * stale copies of either (Phase 3 §37/§52).
 */
export interface DirectoryRepository {
  /** Read-only; never creates a Directory for an owner with no binding yet. */
  getDirectoryForOwner(ownerThreadsUserId: string): Promise<DirectoryRecord | undefined>;

  /** Read-only lookup by directoryId - used by Reset's "is this directory still bound anywhere" check. */
  getDirectoryById(directoryId: string): Promise<DirectoryRecord | undefined>;

  /**
   * The one write path for the portability domain (export/import commit):
   * replaces the owner's Directory content wholesale. On a never-created
   * owner, this lazily creates the Directory + binding in the same
   * operation as the first real mutation (Phase 3.5 Task 7).
   *
   * `mutate` runs with the cross-context Directory lock already held and
   * receives the freshest possible `current` (Phase 3.5 review round 4,
   * High #5) - so a caller whose decision to write at all depends on
   * `current` (e.g. import's concurrency check) must make that decision
   * inside `mutate` itself, not from an earlier unlocked read, or another
   * context's write between that read and the lock can be silently
   * overwritten. `mutate` returns `write: false` to refuse the write
   * entirely (still returning a typed result, e.g. a conflict outcome) or
   * `write: true` with the record to persist.
   *
   * `deleteAbandonedDirectoryIfUnshared` (Phase 3.5 Task 36): when `mutate`
   * adopts a different (old) lineage - a same-owner pristine restore after
   * Reset - also deletes the directoryId it abandons, but only when nothing
   * else is bound to it.
   */
  commitOwnerDirectory<T>(input: {
    ownerThreadsUserId: string;
    createDirectoryId: () => string;
    mutate: (current: DirectoryRecord) => DirectoryMutationOutcome<T>;
    deleteAbandonedDirectoryIfUnshared?: boolean;
  }): Promise<T>;

  /**
   * Reset Directory (Phase 3.5 Task 28): destroys the owner's current
   * Directory and rebinds to a brand-new empty one, in one mutation.
   *
   * Internal/domain capability only - v1.0 exposes no Reset UI (Phase 3.6
   * §27), because a user who wants to start over wants
   * `clearDirectoryForOwner`, which leaves no Directory behind at all.
   */
  resetDirectoryForOwner(ownerThreadsUserId: string, createDirectoryId: () => string): Promise<ResetDirectoryResult>;

  /** Clear this account's data (Phase 3.6 §25/§26): deletes this owner's binding and Directory, leaving every other account, settings and identityCache untouched. */
  clearDirectoryForOwner(ownerThreadsUserId: string): Promise<ClearAccountDirectoryResult>;
}
