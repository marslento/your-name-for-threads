import type { ThreadContact } from "./contact";
import type { ContactTombstone } from "./tombstone";
import type { IdentityConflict } from "./conflict";

/**
 * One private directory's full mutable content (Phase 3.5): contacts,
 * tombstones, and Phase 2's identity index/conflicts. A directory's own
 * identity (`directoryId`) is independent of which Threads account(s), if
 * any, currently bind to it - see `accountBindings` in `ExtensionStorageV4`.
 */
export interface DirectoryRecord {
  directoryId: string;

  contacts: Record<string, ThreadContact>;
  tombstones: Record<string, ContactTombstone>;

  identityIndex: Record<string, string>;
  identityConflicts: Record<string, IdentityConflict>;
}

/**
 * The growth and import limit, contacts and deleted records together. Existing oversized Directories remain
 * editable and fully exportable, with a warning that their files exceed the current restore limits.
 * Deleted records are kept, so deleting a contact does not make room.
 */
export const MAX_DIRECTORY_RECORDS = 20_000;

/** A write that would take a Directory past `MAX_DIRECTORY_RECORDS`. Nothing is written. */
export class DirectoryFullError extends Error {
  constructor() {
    super(`A Directory holds at most ${MAX_DIRECTORY_RECORDS} records`);
    this.name = "DirectoryFullError";
  }
}
