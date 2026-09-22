import { countBindingsToDirectory, getBoundDirectoryId } from "./accountBindings";
import type { DirectoryRecord } from "./directory";

export type ResetDirectoryFailureReason = "no_directory" | "shared_directory";

export type ResetDirectoryResult =
  | {
      ok: true;
      directories: Record<string, DirectoryRecord>;
      accountBindings: Record<string, string>;
      newDirectory: DirectoryRecord;
    }
  | { ok: false; reason: ResetDirectoryFailureReason };

/**
 * Reset Directory (Phase 3.5 Task 28): rebinds the owner to a brand-new
 * empty Directory and drops the old one, as one logical mutation - settings
 * and identityCache are untouched since neither lives on `DirectoryRecord`.
 *
 * Refuses with "no_directory" when the owner has never had one (Reset only
 * ever applies to an existing Directory - Task 30). Refuses with
 * "shared_directory" when the old directoryId's binding count is anything
 * but exactly 1 - a dev-only migration artifact this model does not
 * otherwise produce, but destroying a directoryId another owner is still
 * bound to would destroy that owner's data, so this never happens silently.
 */
export function resetDirectory(input: {
  ownerThreadsUserId: string;
  directories: Readonly<Record<string, DirectoryRecord>>;
  accountBindings: Readonly<Record<string, string>>;
  newDirectoryId: string;
}): ResetDirectoryResult {
  const existingDirectoryId = getBoundDirectoryId(input.accountBindings, input.ownerThreadsUserId);
  if (!existingDirectoryId || !input.directories[existingDirectoryId]) {
    return { ok: false, reason: "no_directory" };
  }
  if (countBindingsToDirectory(input.accountBindings, existingDirectoryId) !== 1) {
    return { ok: false, reason: "shared_directory" };
  }

  const newDirectory: DirectoryRecord = {
    directoryId: input.newDirectoryId,
    contacts: {},
    tombstones: {},
    identityIndex: {},
    identityConflicts: {},
  };

  const directories = { ...input.directories, [input.newDirectoryId]: newDirectory };
  delete directories[existingDirectoryId];

  return {
    ok: true,
    directories,
    accountBindings: { ...input.accountBindings, [input.ownerThreadsUserId]: input.newDirectoryId },
    newDirectory,
  };
}
