import type { ThreadContact } from "./contact";
import type { ContactTombstone } from "./tombstone";

/**
 * The portable durable subset of a directory: identity + contacts +
 * tombstones. Deliberately excludes settings/identityCache/identityIndex/
 * identityConflicts (local derived/preference state, Phase 3 §3) so the
 * portability domain can never accidentally read or leak them.
 */
export interface DirectorySnapshot {
  directoryId: string;

  contacts: Map<string, ThreadContact>;
  tombstones: Map<string, ContactTombstone>;
}
