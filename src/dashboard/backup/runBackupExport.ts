import { backupFilename, exportDirectory, triggerBackupDownload } from "../../portability/exportBackup";
import type { DirectoryRepository } from "../../storage/DirectoryRepository";

/**
 * Shared by the Export card and the pre-import/pre-clear "export current
 * data first" actions. The backup's `exportedBy` is always this confirmed
 * session's own id/username (Phase 3.5 Task 33, Phase 3.6 §4) - never another account's,
 * and never available at all for a never-created owner (no Directory to
 * export in the first place).
 */
export async function runBackupExport(
  ownerThreadsUserId: string,
  ownerUsername: string,
  repository: DirectoryRepository,
  clock: () => string,
): Promise<{ ok: true } | { ok: false }> {
  const directory = await repository.getDirectoryForOwner(ownerThreadsUserId);
  if (!directory) return { ok: false };

  const result = exportDirectory(
    {
      directoryId: directory.directoryId,
      contacts: new Map(Object.entries(directory.contacts)),
      tombstones: new Map(Object.entries(directory.tombstones)),
    },
    { threadsUserId: ownerThreadsUserId, username: ownerUsername },
    clock(),
  );
  if (!result.ok) return { ok: false };

  triggerBackupDownload(backupFilename(result.backup.exportedAt), result.json);
  return { ok: true };
}
