import { countBindingsToDirectory, getBoundDirectoryId } from "./accountBindings";
import type { DirectoryRecord } from "./directory";

export type ClearAccountDirectoryFailureReason = "no_directory" | "shared_directory";

export type ClearAccountDirectoryResult =
  | {
      ok: true;
      directories: Record<string, DirectoryRecord>;
      accountBindings: Record<string, string>;
    }
  | { ok: false; reason: ClearAccountDirectoryFailureReason };

/**
 * "Clear this account's data" (Phase 3.6 §25/§26) - the only destructive
 * data-management action v1.0 exposes at all. It removes exactly two things:
 * this account's binding, and the Directory that binding pointed at. Every
 * other account's binding and Directory is untouched, and `settings` /
 * `identityCache` are browser-global rather than per-Directory, so they are
 * not in this function's reach to damage in the first place (Phase 3.6 §26,
 * checklist #26/#27).
 *
 * This is deliberately NOT `resetDirectory`: Reset rebinds the account to a
 * brand-new empty Directory, leaving it bound. Clearing leaves the account
 * with no Directory at all, back to the never-created empty state - which is
 * what lets the next nickname or import lazily create a fresh one, and what
 * keeps the account's own confirmed session valid throughout (§26: the
 * Dashboard does not lock).
 *
 * Refuses with "no_directory" when there is nothing bound (the UI never
 * offers the action in that state, but the domain does not rely on the UI
 * for that). Refuses with "shared_directory" when the directoryId has
 * anything other than exactly one binding: v1.0 enforces one Directory per
 * account and one account per Directory (Phase 3.6 §3), so this can only
 * arise from dev-only data - and deleting a Directory another account is
 * still bound to would destroy that account's data, which this action
 * promises never to do.
 */
export function clearAccountDirectory(input: {
  ownerThreadsUserId: string;
  directories: Readonly<Record<string, DirectoryRecord>>;
  accountBindings: Readonly<Record<string, string>>;
}): ClearAccountDirectoryResult {
  const directoryId = getBoundDirectoryId(input.accountBindings, input.ownerThreadsUserId);
  if (!directoryId || !input.directories[directoryId]) {
    return { ok: false, reason: "no_directory" };
  }
  if (countBindingsToDirectory(input.accountBindings, directoryId) !== 1) {
    return { ok: false, reason: "shared_directory" };
  }

  const directories = { ...input.directories };
  delete directories[directoryId];

  const accountBindings = { ...input.accountBindings };
  delete accountBindings[input.ownerThreadsUserId];

  return { ok: true, directories, accountBindings };
}
