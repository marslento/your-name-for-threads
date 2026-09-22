import type { DirectoryMutationOutcome } from "./directoryAccess";
import { clearOwnerDirectory, mutateOwnerDirectory, readOwnerDirectory, resetOwnerDirectory } from "./directoryAccess";
import type { DirectoryRepository } from "./DirectoryRepository";
import { RecoveryBlockedError } from "../recovery/RecoveryBlockedError";
import { loadStorageWithQuarantine } from "./migrations";
import type { DirectoryRecord } from "../domain/directory";
import type { ClearAccountDirectoryResult } from "../domain/clearAccountDirectory";
import type { ResetDirectoryResult } from "../domain/resetDirectory";

export class BrowserDirectoryRepository implements DirectoryRepository {
  constructor(private readonly getWriteSignal?: (ownerThreadsUserId: string) => AbortSignal) {}

  async getDirectoryForOwner(ownerThreadsUserId: string): Promise<DirectoryRecord | undefined> {
    // Reads that feed an export or an import preview are held to the same proof as a write (Dashboard source
    // lifecycle design 2026-09-21, DL11): refused when the account no longer authorizes it, and dropped if the
    // proof is withdrawn while storage is being read, so nothing is handed on - or downloaded - afterwards.
    const signal = this.getWriteSignal?.(ownerThreadsUserId);
    const { directory } = await readOwnerDirectory(ownerThreadsUserId);
    signal?.throwIfAborted();
    return directory;
  }

  async getDirectoryById(directoryId: string): Promise<DirectoryRecord | undefined> {
    const { storage, quarantine } = await loadStorageWithQuarantine();
    // A Directory that is set aside exists; answering "not found" would let a caller treat its lineage as new.
    if (Object.hasOwn(quarantine.directories, directoryId)) throw new RecoveryBlockedError("directory", "DIRECTORY_INVALID");
    return storage.directories[directoryId];
  }

  commitOwnerDirectory<T>(input: {
    ownerThreadsUserId: string;
    createDirectoryId: () => string;
    mutate: (current: DirectoryRecord) => DirectoryMutationOutcome<T>;
    deleteAbandonedDirectoryIfUnshared?: boolean;
  }): Promise<T> {
    return mutateOwnerDirectory({ ...input, signal: this.getWriteSignal?.(input.ownerThreadsUserId) });
  }

  async resetDirectoryForOwner(
    ownerThreadsUserId: string,
    createDirectoryId: () => string,
  ): Promise<ResetDirectoryResult> {
    return resetOwnerDirectory(ownerThreadsUserId, createDirectoryId, this.getWriteSignal?.(ownerThreadsUserId));
  }

  async clearDirectoryForOwner(ownerThreadsUserId: string): Promise<ClearAccountDirectoryResult> {
    return clearOwnerDirectory(ownerThreadsUserId, this.getWriteSignal?.(ownerThreadsUserId));
  }
}
