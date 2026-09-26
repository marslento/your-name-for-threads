import { reportDiagnostic } from "../diagnostics/reportDiagnostic";
import { emptyQuarantine, splitDamagedDirectories, type Quarantine } from "../recovery/quarantine";
import type { ThreadContact } from "../domain/contact";
import type { ContactTombstone } from "../domain/tombstone";
import { assertValidTombstone } from "../domain/tombstone";
import type { IdentityCacheEntry } from "../domain/identity";
import type { IdentityConflict } from "../domain/conflict";
import type { DirectoryRecord } from "../domain/directory";
import type { ExtensionSettings, NicknameDisplaySettings } from "../domain/settings";
import { DEFAULT_EXTENSION_SETTINGS, DEFAULT_NICKNAME_DISPLAY_SETTINGS } from "../domain/settings";
import { isValidThreadsUserId } from "../domain/validation";
import type {
  ExtensionStorageV1,
  ExtensionStorageV2,
  ExtensionStorageV3,
  ExtensionStorageV4,
  LegacyIdentityConflictV1,
  LegacyThreadContactV1,
} from "./schema";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCollection<T>(storage: Record<string, unknown>, key: string): Record<string, T> {
  if (!Object.hasOwn(storage, key)) {
    return Object.create(null);
  }

  const collection = storage[key];
  if (!isRecord(collection)) {
    throw new Error(`Invalid storage collection: ${key}`);
  }

  // Stored keys are data, including legacy keys such as __proto__; never inherit dictionary entries.
  return Object.assign(Object.create(null), collection) as Record<string, T>;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readNicknameDisplaySettings(value: unknown): NicknameDisplaySettings {
  const source = isRecord(value) ? value : {};

  return {
    profile: readBoolean(source.profile, DEFAULT_NICKNAME_DISPLAY_SETTINGS.profile),
    feed: readBoolean(source.feed, DEFAULT_NICKNAME_DISPLAY_SETTINGS.feed),
    replies: readBoolean(source.replies, DEFAULT_NICKNAME_DISPLAY_SETTINGS.replies),
    quotes: readBoolean(source.quotes, DEFAULT_NICKNAME_DISPLAY_SETTINGS.quotes),
  };
}

// --- V1 (legacy) parsing -----------------------------------------------

function readV1Settings(storage: Record<string, unknown>): { nicknameDisplay: NicknameDisplaySettings } {
  if (!Object.hasOwn(storage, "settings")) {
    return { nicknameDisplay: DEFAULT_NICKNAME_DISPLAY_SETTINGS };
  }

  const settings = storage.settings;
  if (!isRecord(settings)) {
    throw new Error("Invalid V1 storage collection: settings");
  }

  return { nicknameDisplay: readNicknameDisplaySettings(settings.nicknameDisplay) };
}

function readV1(raw: Record<string, unknown>): ExtensionStorageV1 {
  return {
    schemaVersion: 1,
    contacts: readCollection<LegacyThreadContactV1>(raw, "contacts"),
    identityIndex: readCollection<string>(raw, "identityIndex"),
    identityCache: readCollection<IdentityCacheEntry>(raw, "identityCache"),
    identityConflicts: readCollection<LegacyIdentityConflictV1>(raw, "identityConflicts"),
    settings: readV1Settings(raw),
  };
}

// --- V1 -> V2 transformation --------------------------------------------

export function migrateV1ToV2(v1: ExtensionStorageV1): ExtensionStorageV2 {
  const contacts: Record<string, ThreadContact> = Object.create(null);
  const tombstones: Record<string, ContactTombstone> = Object.create(null);
  const identityIndex: Record<string, string> = { ...v1.identityIndex };

  for (const [id, legacy] of Object.entries(v1.contacts)) {
    if (legacy.deletedAt) {
      const tombstone: ContactTombstone = {
        contactId: legacy.id,
        username: legacy.username,
        createdAt: legacy.createdAt,
        deletedAt: legacy.deletedAt,
        reason: "user_deleted",
        ...(legacy.threadsUserId === undefined ? {} : { threadsUserId: legacy.threadsUserId }),
      };
      assertValidTombstone(tombstone);
      tombstones[tombstone.contactId] = tombstone;

      for (const [key, value] of Object.entries(identityIndex)) {
        if (value === id) delete identityIndex[key];
      }
      continue;
    }

    contacts[id] = {
      id: legacy.id,
      username: legacy.username,
      nickname: legacy.nickname,
      createdAt: legacy.createdAt,
      updatedAt: legacy.updatedAt,
      identityUpdatedAt: legacy.identityUpdatedAt,
      ...(legacy.threadsUserId === undefined ? {} : { threadsUserId: legacy.threadsUserId }),
    };
  }

  const identityConflicts: Record<string, IdentityConflict> = Object.create(null);
  for (const [id, legacyConflict] of Object.entries(v1.identityConflicts)) {
    if (legacyConflict.status !== "pending") continue;

    identityConflicts[id] = {
      id: legacyConflict.id,
      threadsUserId: legacyConflict.threadsUserId,
      contactIds: legacyConflict.contactIds,
      detectedAt: legacyConflict.detectedAt,
    };
  }

  return {
    schemaVersion: 2,
    contacts,
    tombstones,
    identityIndex,
    identityCache: v1.identityCache,
    identityConflicts,
    settings: {
      enabled: DEFAULT_EXTENSION_SETTINGS.enabled,
      nicknameDisplay: v1.settings.nicknameDisplay,
    },
  };
}

// --- V2 parsing (defensive normalize / idempotent pass-through) --------

function readV2Settings(storage: Record<string, unknown>): ExtensionSettings {
  if (!Object.hasOwn(storage, "settings")) {
    return DEFAULT_EXTENSION_SETTINGS;
  }

  const settings = storage.settings;
  if (!isRecord(settings)) {
    throw new Error("Invalid V2 storage collection: settings");
  }

  return {
    enabled: readBoolean(settings.enabled, DEFAULT_EXTENSION_SETTINGS.enabled),
    nicknameDisplay: readNicknameDisplaySettings(settings.nicknameDisplay),
  };
}

function readV2(raw: Record<string, unknown>): ExtensionStorageV2 {
  const contacts = readCollection<ThreadContact>(raw, "contacts");
  const tombstones = readCollection<ContactTombstone>(raw, "tombstones");
  for (const tombstone of Object.values(tombstones)) {
    assertValidTombstone(tombstone);
  }

  return {
    schemaVersion: 2,
    contacts,
    tombstones,
    identityIndex: readCollection<string>(raw, "identityIndex"),
    identityCache: readCollection<IdentityCacheEntry>(raw, "identityCache"),
    identityConflicts: readCollection<IdentityConflict>(raw, "identityConflicts"),
    settings: readV2Settings(raw),
  };
}

// --- V2 -> V3 transformation --------------------------------------------

/**
 * `directoryId` is portable durable data (Phase 3), generated exactly once
 * per installation. It must not be regenerated on every migration pass, so
 * this only runs when upgrading storage that never had one.
 */
export function migrateV2ToV3(
  v2: ExtensionStorageV2,
  createDirectoryId: () => string,
): ExtensionStorageV3 {
  return {
    schemaVersion: 3,
    directory: { directoryId: createDirectoryId() },
    contacts: v2.contacts,
    tombstones: v2.tombstones,
    identityIndex: v2.identityIndex,
    identityCache: v2.identityCache,
    identityConflicts: v2.identityConflicts,
    settings: v2.settings,
  };
}

// --- V3 parsing (defensive normalize / idempotent pass-through) --------

function readDirectory(raw: Record<string, unknown>): { directoryId: string } {
  const directory = raw.directory;
  if (!isRecord(directory) || typeof directory.directoryId !== "string" || !directory.directoryId) {
    throw new Error("Invalid V3 storage collection: directory");
  }

  return { directoryId: directory.directoryId };
}

function readV3(raw: Record<string, unknown>): ExtensionStorageV3 {
  const contacts = readCollection<ThreadContact>(raw, "contacts");
  const tombstones = readCollection<ContactTombstone>(raw, "tombstones");
  for (const tombstone of Object.values(tombstones)) {
    assertValidTombstone(tombstone);
  }

  return {
    schemaVersion: 3,
    directory: readDirectory(raw),
    contacts,
    tombstones,
    identityIndex: readCollection<string>(raw, "identityIndex"),
    identityCache: readCollection<IdentityCacheEntry>(raw, "identityCache"),
    identityConflicts: readCollection<IdentityConflict>(raw, "identityConflicts"),
    settings: readV2Settings(raw),
  };
}

// --- V3 -> V4 transformation --------------------------------------------

/**
 * Phase 3.5 replaces the single browser-global Directory with account-scoped
 * Directory bindings. V3's durable directory content is development-only
 * (no production installs exist yet) and is deliberately discarded here
 * rather than assigned to any Threads account: `directories`/
 * `accountBindings` both start empty, and every account lazily creates its
 * own Directory on first use (Phase 3.5 Task 7). `settings`/`identityCache`
 * remain browser-global and carry over unchanged.
 */
export function migrateV3ToV4(v3: ExtensionStorageV3): ExtensionStorageV4 {
  return {
    schemaVersion: 4,
    directories: {},
    accountBindings: {},
    identityCache: v3.identityCache,
    settings: v3.settings,
  };
}

// --- V4 parsing (defensive normalize / idempotent pass-through) --------

const CONTACT_REQUIRED_STRINGS = ["id", "username", "nickname", "createdAt", "updatedAt", "identityUpdatedAt"] as const;
const CONTACT_OPTIONAL_STRINGS = ["threadsUserId", "note"] as const;

/**
 * A Directory's collections are read as they are stored, never as a guess (Phase 4, review checklist 11: invalid
 * durable data must not be silently skipped or repaired). One that is present but is not a plain record is damage:
 * reading it as `{}` made a Directory whose contacts were garbage look empty and healthy, and the next write would
 * have replaced the garbage with an empty collection. An absent collection is still empty, as it always was.
 * The messages name the Directory and the field, never a value.
 */
function readDirectoryCollection<T>(directory: Record<string, unknown>, name: string, key: string): Record<string, T> {
  const value = directory[name];
  if (value === undefined) return Object.create(null);
  if (!isRecord(value)) throw new Error(`Invalid storage collection: directories.${key}.${name}`);
  return Object.assign(Object.create(null), value) as Record<string, T>;
}

/** Only what the type requires: the strings the rest of the product reads without checking. Extra fields are left alone. */
function assertValidContact(contact: unknown, key: string): void {
  const invalid = () => new Error(`Invalid storage collection: directories.${key}.contacts`);
  if (!isRecord(contact)) throw invalid();
  for (const field of CONTACT_REQUIRED_STRINGS) {
    if (typeof contact[field] !== "string") throw invalid();
  }
  for (const field of CONTACT_OPTIONAL_STRINGS) {
    if (contact[field] !== undefined && typeof contact[field] !== "string") throw invalid();
  }
}

function readDirectoryRecord(value: unknown, key: string): DirectoryRecord {
  if (!isRecord(value) || typeof value.directoryId !== "string" || value.directoryId !== key) {
    throw new Error(`Invalid storage collection: directories.${key}`);
  }

  const contacts = readDirectoryCollection<ThreadContact>(value, "contacts", key);
  const activeUsernames = new Set<string>();
  for (const [contactId, contact] of Object.entries(contacts)) {
    assertValidContact(contact, key);
    if (contact.id !== contactId) throw new Error(`Invalid storage collection: directories.${key}.contacts`);
    if (activeUsernames.has(contact.username)) throw new Error(`Invalid storage collection: directories.${key}.contacts`);
    activeUsernames.add(contact.username);
  }
  const tombstones = readDirectoryCollection<ContactTombstone>(value, "tombstones", key);
  for (const tombstone of Object.values(tombstones)) {
    if (!isRecord(tombstone)) throw new Error(`Invalid storage collection: directories.${key}.tombstones`);
    assertValidTombstone(tombstone);
  }
  const identityIndex = readDirectoryCollection<string>(value, "identityIndex", key);
  for (const [identity, target] of Object.entries(identityIndex)) {
    const contact = typeof target === "string" && Object.hasOwn(contacts, target) ? contacts[target] : undefined;
    if (!contact || (identity !== `username:${contact.username}` &&
      (contact.threadsUserId === undefined || identity !== `threads:${contact.threadsUserId}`))) {
      throw new Error(`Invalid storage collection: directories.${key}.identityIndex`);
    }
  }
  const identityConflicts = readDirectoryCollection<IdentityConflict>(value, "identityConflicts", key);
  for (const [conflictId, conflict] of Object.entries(identityConflicts)) {
    if (!isRecord(conflict) || conflict.id !== conflictId ||
      typeof conflict.threadsUserId !== "string" || typeof conflict.detectedAt !== "string" ||
      !Array.isArray(conflict.contactIds) || !conflict.contactIds.every((id) => typeof id === "string")) {
      throw new Error(`Invalid storage collection: directories.${key}.identityConflicts`);
    }
  }

  return { directoryId: value.directoryId, contacts, tombstones, identityIndex, identityConflicts };
}

function readDirectories(raw: Record<string, unknown>): Record<string, DirectoryRecord> {
  const directories = readCollection<unknown>(raw, "directories");
  const result: Record<string, DirectoryRecord> = Object.create(null);
  for (const [key, value] of Object.entries(directories)) {
    result[key] = readDirectoryRecord(value, key);
  }
  return result;
}

/**
 * The numeric Threads user ID is the only durable ownership key (Phase 3.5
 * review, High #4): a binding keyed by anything else (a username, an empty
 * string) could never be resolved back to a real owner by
 * `getBoundDirectoryId`, and a target that names no real `DirectoryRecord`
 * is indistinguishable from storage corruption at every later read. Both
 * are rejected outright rather than silently dropped or coerced.
 *
 * So is a directoryId two accounts are bound to (Phase 3.6 §3, review round
 * 7 Medium #3): until the Shared Directory feature exists, one Directory
 * belongs to at most one account, and `mutateOwnerDirectory`'s refusal to
 * *create* such a binding is worth nothing if storage that already contains
 * one is loaded and then read and written normally by both accounts. There
 * is no safe guess about which account should keep the data, so this fails
 * the load rather than repairing it - storage is left exactly as it is.
 */
function readAccountBindings(
  raw: Record<string, unknown>,
  directories: Readonly<Record<string, DirectoryRecord>>,
): Record<string, string> {
  const bindings = readCollection<unknown>(raw, "accountBindings");
  const boundOwnerByDirectoryId = new Map<string, string>();
  for (const [ownerId, directoryId] of Object.entries(bindings)) {
    if (!isValidThreadsUserId(ownerId)) {
      throw new Error(`Invalid storage collection: accountBindings key "${ownerId}" is not a numeric Threads user ID`);
    }
    if (typeof directoryId !== "string" || !directoryId) {
      throw new Error(`Invalid storage collection: accountBindings.${ownerId}`);
    }
    if (!Object.hasOwn(directories, directoryId)) {
      throw new Error(`Invalid storage collection: accountBindings.${ownerId} targets unknown directory "${directoryId}"`);
    }
    const alreadyBoundOwner = boundOwnerByDirectoryId.get(directoryId);
    if (alreadyBoundOwner !== undefined) {
      throw new Error(
        `Invalid storage collection: directory "${directoryId}" is bound to both "${alreadyBoundOwner}" and "${ownerId}"`,
      );
    }
    boundOwnerByDirectoryId.set(directoryId, ownerId);
  }
  return bindings as Record<string, string>;
}

function readV4(raw: Record<string, unknown>): ExtensionStorageV4 {
  const directories = readDirectories(raw);
  return {
    schemaVersion: 4,
    directories,
    accountBindings: readAccountBindings(raw, directories),
    identityCache: readCollection<IdentityCacheEntry>(raw, "identityCache"),
    settings: readV2Settings(raw),
  };
}

// --- Versioned dispatch ---------------------------------------------------

/** Normalizes persisted data through the versioned migration dispatch, always to the current (V4) shape. */
export function migrateStorage(raw: unknown): ExtensionStorageV4 {
  if (!isRecord(raw)) {
    throw new Error("Storage must be an object");
  }

  if (!Object.hasOwn(raw, "schemaVersion")) {
    return migrateV3ToV4(migrateV2ToV3(migrateV1ToV2(readV1(raw)), () => crypto.randomUUID()));
  }

  const version = raw.schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new Error("Invalid storage schema version");
  }

  if (version === 1) {
    return migrateV3ToV4(migrateV2ToV3(migrateV1ToV2(readV1(raw)), () => crypto.randomUUID()));
  }

  if (version === 2) {
    return migrateV3ToV4(migrateV2ToV3(readV2(raw), () => crypto.randomUUID()));
  }

  if (version === 3) {
    return migrateV3ToV4(readV3(raw));
  }

  if (version === 4) {
    return readV4(raw);
  }

  throw new Error(`Unsupported storage schema version: ${version}`);
}

/**
 * Every root key V1/V2/V3 ever stored private data under. V4 replaces all
 * of them with `directories`/`accountBindings`, so a migration that only
 * writes the new keys (via `chrome.storage.local.set`, which merges rather
 * than replaces) would leave this old private data sitting at the storage
 * root forever. `migrateStorageDirect` explicitly removes every one of
 * these after writing the V4 snapshot - and `isAlreadyCurrent` below
 * requires them gone, not just `schemaVersion: 4`, so a crash or a failed
 * `remove()` between the two writes gets retried on the next call instead
 * of being permanently mistaken for a finished migration (Phase 3.5 review
 * round 2, Critical #4).
 */
const LEGACY_ROOT_KEYS = [
  "directory",
  "contacts",
  "tombstones",
  "identityIndex",
  "identityConflicts",
] as const;

/** Storage that loaded, and the damaged Directories set aside untouched beside it (Phase 4 Task 17). */
export interface LoadedStorage {
  storage: ExtensionStorageV4;
  quarantine: Quarantine;
}

/**
 * The Directories in current-version data that the loader rejects when each is offered on its own,
 * sorted so the answer does not depend on storage order. Empty for anything that is not current-version
 * data with a `directories` object. The loader stays the only authority on what is valid.
 */
export function findInvalidDirectoryIds(raw: unknown): string[] {
  if (!isRecord(raw) || raw.schemaVersion !== 4 || !isRecord(raw.directories)) return [];
  const directories = raw.directories;
  return Object.keys(directories)
    .sort()
    .filter((id) => {
      try {
        migrateStorage({ schemaVersion: 4, directories: { [id]: directories[id] } });
        return false;
      } catch {
        return true;
      }
    });
}

/**
 * `migrateStorage` for storage that is already the current version: a throw
 * here is stored data that no longer validates (Phase 4 §6). Reported as a
 * code only - the message names owner and Directory ids; recording never
 * touches the storage it is reporting on (§17).
 *
 * Damage confined to whole Directories does not take everyone down with it
 * (Phase 4 Task 17): those Directories, and the bindings that point at them,
 * are set aside untouched, and what is left is loaded if the loader accepts
 * it. Damage anywhere else, or damage that survives setting them aside, is
 * rethrown unchanged: nothing is safe to hand out then.
 */
function readCurrentLoaded(stored: unknown): LoadedStorage {
  try {
    return { storage: migrateStorage(stored), quarantine: emptyQuarantine() };
  } catch (error) {
    reportDiagnostic("STORAGE_VALIDATION_FAILED", "storage");
    const damaged = findInvalidDirectoryIds(stored);
    if (damaged.length > 0) {
      const { usable, quarantine } = splitDamagedDirectories(stored, damaged);
      try {
        return { storage: migrateStorage(usable), quarantine };
      } catch {
        // Something besides those Directories is wrong too.
      }
    }
    throw error;
  }
}

/** Exported for the recovery restore, which acts only on storage that is already current and never migrates it. */
export function isAlreadyCurrent(raw: unknown): raw is { schemaVersion: 4 } {
  return (
    isRecord(raw) &&
    Object.hasOwn(raw, "schemaVersion") &&
    raw.schemaVersion === 4 &&
    LEGACY_ROOT_KEYS.every((key) => !Object.hasOwn(raw, key))
  );
}

/**
 * Performs the actual one-time migration write. Only safe to call from a
 * context that already owns exclusivity for this migration - either
 * `performMigrationOnce` (which grants that within the background's own
 * realm) or a caller with no other choice (`loadAndMigrateStorage`'s
 * fallback, when no coordinator is reachable at all - see there).
 *
 * Accepts an already-fetched `preloaded` snapshot so a caller that already
 * did its own `chrome.storage.local.get()` (to decide whether to call this
 * at all) never reads storage twice for the same check.
 *
 * Every pre-V4 input is a genuine content-changing migration (V3's
 * directory content is discarded, not carried forward - see
 * `migrateV3ToV4`), so this always performs one full-snapshot write, the
 * same way the V1 path always has - followed by an explicit removal of the
 * old root keys (`chrome.storage.local.set` only ever merges/overwrites the
 * keys it is given; it cannot delete ones it omits). Set-then-remove, never
 * the reverse: if the extension is killed (or `remove()` itself fails)
 * between the two calls, the worst case is an orphaned legacy key sitting
 * alongside a V4 `schemaVersion` - never a lost migration - and
 * `isAlreadyCurrent` deliberately does NOT treat that as done: the next
 * call retries this same path (a harmless redundant full-snapshot write of
 * already-current V4 content) until `remove()` actually succeeds.
 */
async function migrateStorageDirect(preloaded?: unknown): Promise<ExtensionStorageV4> {
  const stored = preloaded !== undefined ? preloaded : await chrome.storage.local.get();
  if (isAlreadyCurrent(stored)) {
    return readCurrentLoaded(stored).storage;
  }

  try {
    const migrated = migrateStorage(stored);
    await chrome.storage.local.set(migrated);
    await chrome.storage.local.remove([...LEGACY_ROOT_KEYS]);
    return migrated;
  } catch (error) {
    reportDiagnostic("STORAGE_MIGRATION_FAILED", "storage");
    throw error;
  }
}

export const STORAGE_MIGRATION_MESSAGE_TYPE = "tpd:ensure-storage-migrated";

let migrationPromise: Promise<ExtensionStorageV4> | null = null;

/**
 * The single coordinator for the one-time migration (Phase 3 review round
 * 2, P1): call this only from the background service worker. Its
 * check-and-set of `migrationPromise` happens synchronously (before any
 * `await`), so any number of calls arriving before the first settles -
 * whether direct calls or, via `src/background/serviceWorker.ts`'s message
 * listener, `sendMessage`s from every other extension context - correctly
 * dedupe onto the exact same in-flight migration and its exact same
 * result. This is what closes the "A writes A and returns, B writes B and
 * returns, storage ends up B" divergence: B never performs an independent
 * migration at all, it just awaits A's.
 *
 * `migrationPromise` exists only to dedupe *in-flight* work - it is cleared
 * in `finally` the moment the attempt settles, success or failure alike.
 * Two consequences (Phase 3 review round 3, High #1): a failed migration
 * can be retried by the very next call instead of every future caller
 * inheriting the same rejection forever, and - more importantly - the
 * resolved snapshot handed to one caller is never handed to a *later*
 * caller as if it were still current. Every consumer of this function
 * re-reads storage itself once the coordinator confirms migration is done
 * (see `loadAndMigrateStorage`), so a message that arrives after another
 * context already wrote new contacts/tombstones always observes them,
 * instead of a stale snapshot frozen at the moment migration completed.
 */
export function performMigrationOnce(): Promise<ExtensionStorageV4> {
  if (!migrationPromise) {
    migrationPromise = migrateStorageDirect().finally(() => {
      migrationPromise = null;
    });
  }
  return migrationPromise;
}

/** Test-only: module state otherwise persists for the lifetime of a background service worker (by design) or a test file (not by design). */
export function __resetMigrationCoordinatorForTests(): void {
  migrationPromise = null;
}

/** True shape of the background service worker's reply - deliberately carries no storage payload, see `loadAndMigrateStorage` below. */
type MigrationCoordinatorReply = { ok: true } | { ok: false; error: string };

function isMigrationCoordinatorReply(value: unknown): value is MigrationCoordinatorReply {
  return isRecord(value) && typeof value.ok === "boolean";
}

/**
 * Reading already-current storage must be a pure read. Writing back on every
 * read (even a no-op "normalization") lets a slow/stale read's write-back
 * land after a concurrent delete or merge's write and silently clobber it -
 * resurrecting a contact with no tombstone. Only input below the current
 * version performs the one-time migration; already-current input is read
 * and normalized in memory only, with no messaging at all - this stays a
 * cheap local read for the overwhelming majority of calls, forever, once
 * the one-time migration has happened anywhere.
 *
 * Every real extension context except the background service worker itself
 * (which *is* the coordinator) routes the one-time migration through
 * `performMigrationOnce` via message passing, so two contexts racing the
 * very first migration - including a V1/fresh-install one, which genuinely
 * rewrites contacts/tombstones - converge on one migration attempt and one
 * `directoryId`, never two independent ones.
 *
 * The coordinator's reply carries only a completion status (Phase 3 review
 * round 3, High #1) - never the storage snapshot itself. A reply that DID
 * carry the snapshot would hand every caller whatever the coordinator saw
 * at the moment ITS migration resolved, which can already be stale by the
 * time a given message round-trips back (e.g. a sibling context committed a
 * new contact in between). So once the coordinator confirms migration is
 * done, this function performs its own fresh `chrome.storage.local.get()`
 * - the only read that is guaranteed current as of *this* call.
 *
 * If no coordinator can be reached at all (message rejected, or no
 * `chrome.runtime.sendMessage` in this context), this never falls back to
 * migrating directly - that fallback is exactly the unsynchronized race
 * this coordinator exists to prevent. It throws a retryable error instead;
 * callers already treat a rejected `loadAndMigrateStorage()` as "try again
 * shortly" (e.g. the popup keeps its last-known settings and the next
 * `chrome.storage.onChanged` event or remount retries).
 */
export async function loadStorageWithQuarantine(): Promise<LoadedStorage> {
  const stored = await chrome.storage.local.get();
  if (isAlreadyCurrent(stored)) {
    return readCurrentLoaded(stored);
  }

  if (typeof window === "undefined") {
    // This code is itself running in the background service worker - it IS the coordinator, so its migration is done by the time it resolves; read the result fresh rather than trust its resolved value.
    await performMigrationOnce();
    return readCurrentLoaded(await chrome.storage.local.get());
  }

  if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
    let reply: MigrationCoordinatorReply | undefined;
    try {
      const response: unknown = await chrome.runtime.sendMessage({ type: STORAGE_MIGRATION_MESSAGE_TYPE });
      reply = isMigrationCoordinatorReply(response) ? response : undefined;
    } catch {
      reply = undefined;
    }
    if (reply?.ok) {
      return readCurrentLoaded(await chrome.storage.local.get());
    }
    // A reply that explicitly says "failed" (as opposed to no reply at all)
    // means the coordinator WAS reached and the migration itself is broken
    // (e.g. genuinely corrupt/unsupported stored data) - surface that
    // specific reason rather than masking it as "unreachable, just retry".
    if (reply && !reply.ok) {
      throw new Error(reply.error);
    }
  }

  throw new Error("Storage migration coordinator is unreachable; retry once the background service worker is available.");
}

/**
 * The usable part of storage. A Directory that is damaged on its own (Phase 4 Task 17) is simply absent
 * from it, along with the bindings that point at it, so every caller that has nothing to do with that
 * Directory - settings, the identity cache, another account's data - keeps working. A caller that acts
 * for one account, or writes `directories` or `accountBindings`, must use `loadStorageWithQuarantine`
 * instead: for such a caller "absent" would read as "this account has no data yet", and the write would
 * drop what was set aside.
 */
export async function loadAndMigrateStorage(): Promise<ExtensionStorageV4> {
  return (await loadStorageWithQuarantine()).storage;
}
