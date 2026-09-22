import { findInvalidDirectoryIds, migrateStorage } from "../storage/migrations";
import { splitDamagedDirectories } from "./quarantine";
import type { RecoveryCode } from "./recoveryTypes";

/**
 * A directory's `directoryId` is a storage key, and in damaged data it can be any string at all, so it
 * is only ever compared with the ID an account is bound to. Never show it, log it or record it.
 */
export type StorageHealth =
  | { kind: "healthy" }
  | { kind: "directory_error"; directoryId: string; code: RecoveryCode }
  | { kind: "global_error"; code: RecoveryCode };

const CURRENT_SCHEMA_VERSION = 4;
const ROOT_COLLECTIONS = ["directories", "accountBindings", "identityCache", "settings"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const globalError = (code: RecoveryCode): StorageHealth => ({ kind: "global_error", code });

/**
 * Whether the real loader's validator accepts `raw`. It is the only authority on that: nothing below
 * re-decides it, so "healthy" can never disagree with `migrateStorage`, and a rule added to it is a rule
 * here. (`loadAndMigrateStorage` is more forgiving, by design: it sets a damaged Directory aside and
 * loads the rest. That is exactly the distinction this module draws.) `migrateStorage` is pure: it
 * reads, and it writes nothing.
 */
function loads(raw: unknown): boolean {
  try {
    migrateStorage(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * The Directories in current-version data that the loader rejects when each is offered on its own,
 * sorted so the answer does not depend on storage order. Empty for anything that is not current-version
 * data with a `directories` object.
 *
 * `validateStorageHealth` names only the first, because its result has room for one. A caller that
 * decides for one account (the Recovery coordinator) must use this instead, or a second damaged
 * Directory would read as healthy.
 */
export const invalidDirectoryIds: (raw: unknown) => string[] = findInvalidDirectoryIds;

function classify(raw: unknown): StorageHealth {
  if (!isRecord(raw)) return globalError("STORAGE_ROOT_INVALID");

  if (Object.hasOwn(raw, "schemaVersion")) {
    const version = raw.schemaVersion;
    if (typeof version !== "number" || !Number.isInteger(version)) return globalError("SCHEMA_VERSION_INVALID");
    if (version < 1 || version > CURRENT_SCHEMA_VERSION) return globalError("SCHEMA_VERSION_UNSUPPORTED");
  }
  // Data the loader rejects, in an older or unversioned layout: it is the migration that cannot cope.
  if (raw.schemaVersion !== CURRENT_SCHEMA_VERSION) return globalError("MIGRATION_FAILED");

  for (const key of ROOT_COLLECTIONS) {
    if (Object.hasOwn(raw, key) && !isRecord(raw[key])) return globalError("COLLECTION_INVALID");
  }

  // Take the damaged Directories, and any binding that points at one, out of the picture. If the loader
  // then accepts what is left, they were the whole problem. If it does not, something else is wrong
  // too, and it is not safe to say the rest of the data is usable.
  const damaged = invalidDirectoryIds(raw);
  const { usable: rest } = splitDamagedDirectories(raw, damaged);
  if (!loads(rest)) return globalError(loads({ ...rest, accountBindings: {} }) ? "BINDINGS_INVALID" : "STORAGE_INVALID");

  return damaged.length > 0 ? { kind: "directory_error", directoryId: damaged[0], code: "DIRECTORY_INVALID" } : globalError("STORAGE_INVALID");
}

/**
 * Classifies raw `chrome.storage.local` contents (Phase 4 Task 16): healthy, one damaged Directory, or a
 * fault in the root, the bindings or the migration that puts every Directory in doubt.
 *
 * It only reads. It never repairs, skips a record, or writes a marker into what it inspects (section 17),
 * and it does not throw whatever it is given. Fail closed: anything it cannot place is `global_error`.
 * A failure to read storage at all is not this function's business, because it never sees storage:
 * that is a transient fault, not damaged data.
 */
export function validateStorageHealth(raw: unknown): StorageHealth {
  if (loads(raw)) return { kind: "healthy" };
  try {
    return classify(raw);
  } catch {
    // Not reachable for data that came out of storage; if it ever is, the widest scope is the safe one.
    return globalError("STORAGE_INVALID");
  }
}
