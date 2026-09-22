import { countBindingsToDirectory, getBoundDirectoryId } from "../domain/accountBindings";
import { clearAccountDirectory, type ClearAccountDirectoryResult } from "../domain/clearAccountDirectory";
import type { DirectoryRecord } from "../domain/directory";
import { resetDirectory, type ResetDirectoryResult } from "../domain/resetDirectory";
import { normalizeThreadsUserId } from "../domain/validation";
import { RecoveryBlockedError } from "../recovery/RecoveryBlockedError";
import type { Quarantine } from "../recovery/quarantine";
import { withDirectoryLock } from "./directoryLock";
import { loadStorageWithQuarantine } from "./migrations";
import type { ExtensionStorageV4 } from "./schema";

/**
 * Serializes every owner-directory read-modify-write issued through this
 * module within one JS context (mirrors `IdentityCoordinator`'s queue and
 * `migrations.ts`'s `performMigrationOnce` singleton) - cheap, so a burst of
 * calls from the SAME context only ever has one waiting on the cross-context
 * lock below at a time, instead of each opening its own port. The actual
 * cross-context guarantee - two separate contexts (a content script tab and
 * the Dashboard, or two different tabs) mutating at the same instant, which
 * this local queue alone cannot prevent (Phase 3.5 review, Medium #7) - is
 * `withDirectoryLock` in `directoryLock.ts` (Phase 3.5 review round 3, High
 * #4): storage is re-read fresh only after that lock is actually held, so a
 * second mutation can never act on a snapshot the first's write has already
 * superseded.
 */
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task, task);
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * An account whose Directory is set aside (Phase 4 Task 17) must not be read as an account with no
 * Directory yet: the next write would bind it to a new one and orphan its data. Fail closed instead, and
 * before anything is written. Only that account is blocked; every other Directory carries on.
 */
export function assertNotInRecovery(quarantine: Quarantine, owner: string): void {
  if (getBoundDirectoryId(quarantine.accountBindings, owner) !== undefined) {
    throw new RecoveryBlockedError("directory", "DIRECTORY_INVALID");
  }
}

/**
 * What every write puts back beside the usable data: the Directories that were set aside, and the
 * bindings that point at them, exactly as stored. `set` replaces a whole key, so leaving them out would
 * delete them.
 */
function withQuarantine(
  quarantine: Quarantine,
  directories: Record<string, DirectoryRecord>,
  accountBindings: Record<string, string>,
) {
  return {
    directories: { ...quarantine.directories, ...directories },
    accountBindings: { ...quarantine.accountBindings, ...accountBindings },
  };
}

/** Read-only: never creates a Directory. Returns `undefined` for an owner with no binding yet. */
export async function readOwnerDirectory(
  ownerThreadsUserId: string,
): Promise<{ storage: ExtensionStorageV4; directory: DirectoryRecord | undefined }> {
  const owner = normalizeThreadsUserId(ownerThreadsUserId);
  const { storage, quarantine } = await loadStorageWithQuarantine();
  assertNotInRecovery(quarantine, owner);
  const directoryId = getBoundDirectoryId(storage.accountBindings, owner);
  return { storage, directory: directoryId ? storage.directories[directoryId] : undefined };
}

function emptyDirectory(directoryId: string): DirectoryRecord {
  return { directoryId, contacts: {}, tombstones: {}, identityIndex: {}, identityConflicts: {} };
}

/** What a `mutateOwnerDirectory` call decided to do, alongside whatever result value the caller needs regardless. */
export type DirectoryMutationOutcome<T> =
  | { write: false; result: T }
  | { write: true; record: DirectoryRecord; result: T };

/**
 * The one entry point for every durable owner-directory mutation (Phase 3.5
 * Task 7): reads current storage, hands `mutate` the owner's existing
 * DirectoryRecord or - if none is bound yet - an empty placeholder (Phase
 * 3.5 review round 4, High #5: its `directoryId` is `""`, NOT a fresh id
 * minted up front - `input.createDirectoryId()` only ever runs once a write
 * actually happens, at the very end, so a caller that needs to run
 * lock-held checks against `current` before deciding whether/what to write
 * - e.g. import's concurrency check, which compares against a `""`
 * placeholder captured the same way at session-build time - never sees a
 * directoryId it can't reproduce). `mutate` never has to know or care
 * whether it is creating or updating: if it writes back a record whose
 * `directoryId` it left blank (e.g. by spreading `current` unchanged), the
 * final write stamps in the minted id itself. The Directory and its binding
 * are created in the exact same write as the mutation itself, and only when
 * `mutate` actually asks to (`write: true`): a no-op outcome (`write: false`
 * - "nothing to delete", "nothing to attach") performs no write at all, so
 * it can never leave a dangling empty binding, while still letting the
 * caller return a real result value (not just null) for that case. `mutate`
 * may also throw synchronously (e.g. a real conflict) to reject the whole
 * call with no write, same as an ordinary async function.
 *
 * `mutate` may return a record whose `directoryId` differs from the one it
 * was handed (adopting a different lineage - a pristine restore of an old
 * backup, or a Reset): the binding is repointed at that id. The
 * previously-bound directoryId's entry is deliberately NOT deleted here
 * *unless* the caller opts into `deleteAbandonedDirectoryIfUnshared` (Phase
 * 3.5 Task 36) - a shared directoryId (more than one owner bound to it)
 * must not be removed just because one of those owners moved off it, and by
 * default this generic helper has no way to know whether that is the case.
 * Reset itself (Phase 3.5 Task 28) uses the dedicated `resetOwnerDirectory`
 * below instead, since it deletes unconditionally rather than adopting.
 *
 * `ownerThreadsUserId` is normalized (and rejected if not a numeric Threads
 * ID) before it ever reaches a binding write - `readV4`'s parser already
 * rejects a non-numeric binding key, but validating only on the next read
 * would mean this API had itself just produced unreadable storage (Phase
 * 3.5 review round 2, Critical #3).
 */
export function mutateOwnerDirectory<T>(input: {
  ownerThreadsUserId: string;
  /** Captured at enqueue time; reconfirmation must not revive revoked work. */
  signal?: AbortSignal;
  createDirectoryId: () => string;
  mutate: (current: DirectoryRecord) => DirectoryMutationOutcome<T>;
  /**
   * Same-owner pristine restore after Reset (Phase 3.5 Task 36): when
   * `mutate` adopts a different (old) lineage, the empty directory it
   * abandons is deleted in the same write, but only when nothing else is
   * bound to it - never when another owner still is.
   */
  deleteAbandonedDirectoryIfUnshared?: boolean;
}): Promise<T> {
  return enqueue(() =>
    withDirectoryLock(async () => {
      input.signal?.throwIfAborted();
      const owner = normalizeThreadsUserId(input.ownerThreadsUserId);
      const { storage, quarantine } = await loadStorageWithQuarantine();
      assertNotInRecovery(quarantine, owner);
      // Proof can change while acquiring the lock OR awaiting this read.
      // No await separates the final check below from dispatching the write.
      input.signal?.throwIfAborted();
      const existingDirectoryId = getBoundDirectoryId(storage.accountBindings, owner);
      const current = existingDirectoryId ? storage.directories[existingDirectoryId] : emptyDirectory("");

      const outcome = input.mutate(current);
      if (!outcome.write) {
        return outcome.result;
      }

      const finalDirectoryId = outcome.record.directoryId || input.createDirectoryId();

      // A Directory that is set aside is not this account's to overwrite, whoever's it is: a backup
      // exported from a damaged Directory's lineage would otherwise land on top of it.
      if (Object.hasOwn(quarantine.directories, finalDirectoryId)) {
        throw new RecoveryBlockedError("directory", "DIRECTORY_INVALID");
      }

      // v1.0 single-binding invariant (Phase 3.6 §3): one Directory, at most
      // one account. Adopting a directoryId another account is already bound
      // to would silently hand this account that account's data - and then
      // let both write over each other. Until the Shared Directory feature
      // actually exists, that is never a legal state, so this fails closed
      // rather than writing it.
      //
      // Checked for every write, not only for the binding-repointing ones
      // (review round 7, Medium #3): if storage somehow already contains a
      // shared directoryId, an ordinary in-place mutation through one of the
      // two accounts overwrites the other's contacts just as thoroughly as
      // adopting it would. `readV4` now rejects such storage on load, so in
      // practice this never fires - which is exactly why it is cheap to keep
      // as the write-side half of the same invariant.
      if (
        Object.entries(storage.accountBindings).some(([boundOwner, boundId]) => boundId === finalDirectoryId && boundOwner !== owner)
      ) {
        throw new Error("Refusing to write a directory that another Threads account is already bound to");
      }

      const finalRecord =
        outcome.record.directoryId === finalDirectoryId ? outcome.record : { ...outcome.record, directoryId: finalDirectoryId };
      const directories = { ...storage.directories, [finalDirectoryId]: finalRecord };
      const accountBindings =
        existingDirectoryId === finalDirectoryId
          ? storage.accountBindings
          : { ...storage.accountBindings, [owner]: finalDirectoryId };

      if (
        input.deleteAbandonedDirectoryIfUnshared &&
        existingDirectoryId &&
        existingDirectoryId !== finalDirectoryId &&
        countBindingsToDirectory(storage.accountBindings, existingDirectoryId) === 1
      ) {
        delete directories[existingDirectoryId];
      }

      input.signal?.throwIfAborted();
      await chrome.storage.local.set(withQuarantine(quarantine, directories, accountBindings));
      return outcome.result;
    }),
  );
}

/**
 * Reset Directory (Phase 3.5 Task 28): the one dedicated entry point for
 * destroying the owner's current Directory outright and starting over
 * empty, guarded by the domain's own multi-binding check (`resetDirectory`)
 * so a shared directoryId is never destroyed out from under another owner.
 */
export function resetOwnerDirectory(
  ownerThreadsUserId: string,
  createDirectoryId: () => string,
  signal?: AbortSignal,
): Promise<ResetDirectoryResult> {
  return enqueue(() =>
    withDirectoryLock(async () => {
      signal?.throwIfAborted();
      const owner = normalizeThreadsUserId(ownerThreadsUserId);
      const { storage, quarantine } = await loadStorageWithQuarantine();
      assertNotInRecovery(quarantine, owner);
      signal?.throwIfAborted();
      const result = resetDirectory({
        ownerThreadsUserId: owner,
        directories: storage.directories,
        accountBindings: storage.accountBindings,
        newDirectoryId: createDirectoryId(),
      });
      if (!result.ok) return result;

      signal?.throwIfAborted();
      await chrome.storage.local.set(withQuarantine(quarantine, result.directories, result.accountBindings));
      return result;
    }),
  );
}

/**
 * "Clear this account's data" (Phase 3.6 §25): deletes the current account's
 * binding and Directory, and nothing else. Goes through the same queue and
 * cross-context lock as every other directory mutation, so it can never race
 * a concurrent import/nickname write into a half-cleared state, and writes
 * only `directories`/`accountBindings` - `settings` and `identityCache` are
 * separate storage keys this never touches (Phase 3.6 §26).
 */
export function clearOwnerDirectory(ownerThreadsUserId: string, signal?: AbortSignal): Promise<ClearAccountDirectoryResult> {
  return enqueue(() =>
    withDirectoryLock(async () => {
      signal?.throwIfAborted();
      const owner = normalizeThreadsUserId(ownerThreadsUserId);
      const { storage, quarantine } = await loadStorageWithQuarantine();
      assertNotInRecovery(quarantine, owner);
      signal?.throwIfAborted();
      const result = clearAccountDirectory({
        ownerThreadsUserId: owner,
        directories: storage.directories,
        accountBindings: storage.accountBindings,
      });
      if (!result.ok) return result;

      signal?.throwIfAborted();
      await chrome.storage.local.set(withQuarantine(quarantine, result.directories, result.accountBindings));
      return result;
    }),
  );
}

export type ClearDamagedDirectoryResult = { ok: true } | { ok: false; reason: "not_in_recovery" | "shared_directory" };

/**
 * "Clear this account's data" for an account whose Directory is in Recovery (Phase 4 Task 19): the one way
 * out that deletes a damaged Directory, and only ever this account's own. `clearOwnerDirectory` refuses a
 * Directory that is set aside on purpose, so that an ordinary action can never reach one; this is the
 * deliberate exception, offered only on the Recovery page and only after the person has confirmed it.
 *
 * It removes exactly two things - the account's binding and the Directory it points at - and puts every
 * other Directory, binding and key back as it found them, the set-aside ones of other accounts included.
 * It refuses when the account is not in Recovery, and when anything besides this account is bound to the
 * Directory (v1.0 has one account per Directory, so that is dev-only data, and deleting it would take that
 * account's data too). Through the same queue and cross-context lock as every other Directory write.
 */
export function clearDamagedOwnerDirectory(ownerThreadsUserId: string, signal?: AbortSignal): Promise<ClearDamagedDirectoryResult> {
  return enqueue(() =>
    withDirectoryLock(async () => {
      signal?.throwIfAborted();
      const owner = normalizeThreadsUserId(ownerThreadsUserId);
      const { storage, quarantine } = await loadStorageWithQuarantine();
      signal?.throwIfAborted();

      const directoryId = getBoundDirectoryId(quarantine.accountBindings, owner);
      if (directoryId === undefined) return { ok: false, reason: "not_in_recovery" } as const;
      // Every binding that points at a set-aside Directory is itself set aside, so this counts them all.
      if (countBindingsToDirectory(quarantine.accountBindings, directoryId) !== 1) return { ok: false, reason: "shared_directory" } as const;

      const keptDirectories = Object.fromEntries(Object.entries(quarantine.directories).filter(([id]) => id !== directoryId));
      const keptBindings = Object.fromEntries(Object.entries(quarantine.accountBindings).filter(([boundOwner]) => boundOwner !== owner));
      signal?.throwIfAborted();
      await chrome.storage.local.set({
        directories: { ...keptDirectories, ...storage.directories },
        accountBindings: { ...keptBindings, ...storage.accountBindings },
      });
      return { ok: true } as const;
    }),
  );
}

/** Test-only: the queue is module-level state that otherwise persists for the life of a context (by design) or a test file (not by design). */
export function __resetDirectoryAccessQueueForTests(): void {
  queue = Promise.resolve();
}
