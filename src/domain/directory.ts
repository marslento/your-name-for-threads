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
