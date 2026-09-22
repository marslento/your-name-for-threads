import type { ThreadContact } from "../domain/contact";
import type { ContactTombstone } from "../domain/tombstone";
import type { IdentityCacheEntry } from "../domain/identity";
import type { IdentityConflict } from "../domain/conflict";
import type { ExtensionSettings, NicknameDisplaySettings } from "../domain/settings";
import type { DirectoryRecord } from "../domain/directory";

/**
 * V1 shapes describe legacy persisted data, not the current domain model.
 * Kept independent of `../domain/*` (which now describes V2) so the V1→V2
 * migration has a precise, frozen description of what it reads.
 */
export interface LegacyThreadContactV1 {
  id: string;

  threadsUserId?: string;
  username: string;

  nickname: string;

  createdAt: string;
  updatedAt: string;
  identityUpdatedAt: string;

  deletedAt?: string;
}

export interface LegacyIdentityConflictV1 {
  id: string;

  threadsUserId: string;
  contactIds: string[];

  detectedAt: string;

  status: "pending" | "resolved";
}

export interface LegacyExtensionSettingsV1 {
  nicknameDisplay: NicknameDisplaySettings;
}

export interface ExtensionStorageV1 {
  schemaVersion: 1;

  contacts: Record<string, LegacyThreadContactV1>;

  identityIndex: Record<string, string>;

  identityCache: Record<string, IdentityCacheEntry>;

  identityConflicts: Record<string, LegacyIdentityConflictV1>;

  settings: LegacyExtensionSettingsV1;
}

export interface ExtensionStorageV2 {
  schemaVersion: 2;

  contacts: Record<string, ThreadContact>;
  tombstones: Record<string, ContactTombstone>;

  identityIndex: Record<string, string>;
  identityCache: Record<string, IdentityCacheEntry>;
  identityConflicts: Record<string, IdentityConflict>;

  settings: ExtensionSettings;
}

/**
 * The `directoryId` identifies one directory's lineage across backup/restore
 * (Phase 3). It is portable durable data - unlike `contacts`/`tombstones`,
 * it is never rebuilt from other fields, so migration must generate it
 * exactly once and every later read must preserve it unchanged.
 */
export interface DirectoryMetadata {
  directoryId: string;
}

export interface ExtensionStorageV3 {
  schemaVersion: 3;

  directory: DirectoryMetadata;

  contacts: Record<string, ThreadContact>;
  tombstones: Record<string, ContactTombstone>;

  identityIndex: Record<string, string>;
  identityCache: Record<string, IdentityCacheEntry>;
  identityConflicts: Record<string, IdentityConflict>;

  settings: ExtensionSettings;
}

/**
 * V4 (Phase 3.5) separates a Threads account's binding from the Directory
 * content itself: `directories` holds every Directory record, keyed by its
 * own `directoryId`, while `accountBindings` maps a numeric Threads user ID
 * to the single `directoryId` it currently points at. A binding is durable
 * data but carries no username - display metadata is session-only, never
 * persisted here (see `src/account/`). `settings`/`identityCache` remain
 * browser-global exactly as in V2/V3, shared across every Directory.
 *
 * `directories`/`accountBindings` are each one `chrome.storage.local` key
 * holding every owner's data, so two different owners writing at once could
 * in principle race on a last-write-wins basis and silently drop one
 * another's mutation - with no automatic recovery (Phase 3.5 review, Medium
 * #7: an overwritten binding/Directory does not repair itself). Every
 * owner-directory mutation is therefore serialized through one coordinator
 * (`src/storage/directoryAccess.ts`'s `mutateOwnerDirectory`/
 * `resetOwnerDirectory`/`clearOwnerDirectory`), which local in-process queuing alone cannot cover
 * across two genuinely separate JS contexts (a content script tab and the
 * Dashboard, or two separate tabs) - `chrome.storage.local` itself has no
 * cross-context transaction primitive. That gap is closed by a
 * background-arbitrated `chrome.runtime.Port` lock (`directoryLock.ts`,
 * Phase 3.5 review round 3, High #4): storage is re-read fresh only after
 * the lock is actually held, and every caller that decides whether/what to
 * write based on current state (including import's concurrency check,
 * Phase 3.5 review round 4, High #5) makes that decision from inside the
 * lock-held read, not an earlier unlocked one - so no owner-directory
 * mutation path bypasses this serialization.
 */
export interface ExtensionStorageV4 {
  schemaVersion: 4;

  directories: Record<string, DirectoryRecord>;
  accountBindings: Record<string, string>;

  identityCache: Record<string, IdentityCacheEntry>;
  settings: ExtensionSettings;
}
