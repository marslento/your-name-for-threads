/**
 * Why private-data features are paused (Phase 4 section 16). A closed set of machine codes: like a
 * diagnostic, a code carries none of the stored data that made it necessary, so it is safe to show,
 * to record, and to copy into a bug report.
 *
 * Directory scope: one Directory's record is unusable, and every other Directory is unaffected.
 * - `DIRECTORY_INVALID`
 *
 * Global scope: something the whole private-data layer stands on is unusable, so all of it pauses.
 * - `STORAGE_ROOT_INVALID`: what storage holds is not an object at all.
 * - `SCHEMA_VERSION_INVALID`: the version marker is not a whole number.
 * - `SCHEMA_VERSION_UNSUPPORTED`: a whole number this build does not know, for example data written
 *   by a newer version of the extension.
 * - `COLLECTION_INVALID`: `directories`, `accountBindings`, `identityCache` or `settings` is present
 *   but is not an object.
 * - `BINDINGS_INVALID`: which account owns which Directory cannot be trusted (a key that is not a
 *   Threads user ID, a target that does not exist, or one Directory bound twice).
 * - `MIGRATION_FAILED`: data in an older layout cannot be migrated.
 * - `STORAGE_INVALID`: the loader rejects the data and no narrower cause was found. Fails closed at
 *   the widest scope rather than guess.
 */
export const RECOVERY_CODES = [
  "DIRECTORY_INVALID",
  "STORAGE_ROOT_INVALID",
  "SCHEMA_VERSION_INVALID",
  "SCHEMA_VERSION_UNSUPPORTED",
  "COLLECTION_INVALID",
  "BINDINGS_INVALID",
  "MIGRATION_FAILED",
  "STORAGE_INVALID",
] as const;

export type RecoveryCode = (typeof RECOVERY_CODES)[number];

/**
 * What one account sees (design summary section 16). `directory` means that account's own Directory is
 * damaged; it says nothing about anyone else's, and carries no Directory ID because nothing that
 * shows this state needs one.
 */
export type RecoveryState =
  | { kind: "none" }
  | { kind: "directory"; code: RecoveryCode }
  | { kind: "global"; code: RecoveryCode };
