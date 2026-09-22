import { normalizeThreadsUserId } from "../domain/validation";
import type { RecoveryState } from "./recoveryTypes";
import { invalidDirectoryIds, validateStorageHealth } from "./validateStorageHealth";

const NONE: RecoveryState = { kind: "none" };

/**
 * What one account sees (Phase 4 Task 17), decided from raw `chrome.storage.local` contents alone.
 *
 * - Nothing is wrong, or only some other account's Directory is: `none`. Damage to Bob's Directory says
 *   nothing about Alice's, and must not take her data away.
 * - This account's own Directory is damaged: `directory`.
 * - The root, the bindings or the migration is unsound, so every Directory is in doubt: `global`,
 *   whoever asks and whether or not anyone is signed in.
 *
 * Every damaged Directory counts, not only the first the classifier names: a second one would otherwise
 * read as healthy. No account (`null`) has no Directory to be damaged, so directory-scoped damage is
 * `none` for it; global damage is not.
 *
 * It is a pure function of what is stored, so there is nothing to persist and no marker to put in the
 * wrong place: entering Recovery writes nothing, least of all into the payload that is broken
 * (design summary section 17).
 */
export function recoveryStateFor(raw: unknown, ownerThreadsUserId: string | null): RecoveryState {
  const health = validateStorageHealth(raw);
  if (health.kind === "healthy") return NONE;
  if (health.kind === "global_error") return { kind: "global", code: health.code };
  if (ownerThreadsUserId === null) return NONE;

  let owner: string;
  try {
    owner = normalizeThreadsUserId(ownerThreadsUserId);
  } catch {
    return NONE; // not an account ID, so nothing is bound to it
  }
  const bindings = (raw as { accountBindings?: Record<string, unknown> }).accountBindings;
  const boundDirectoryId = bindings !== undefined && Object.hasOwn(bindings, owner) ? bindings[owner] : undefined;

  return typeof boundDirectoryId === "string" && invalidDirectoryIds(raw).includes(boundDirectoryId) ? { kind: "directory", code: "DIRECTORY_INVALID" } : NONE;
}

/**
 * Reads storage once and returns `recoveryStateFor` it. It never writes.
 *
 * A storage read that fails is rejected as it is, not turned into a Recovery state: Recovery is for data
 * that is damaged, and a transient fault must not tell a healthy account its data needs recovery, nor
 * may it be read as "healthy". The caller keeps the private features off until this resolves.
 */
export async function readRecoveryState(ownerThreadsUserId: string | null): Promise<RecoveryState> {
  return recoveryStateFor(await chrome.storage.local.get(), ownerThreadsUserId);
}
