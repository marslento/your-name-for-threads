import { z } from "zod";

import { countVisibleCharacters, MAX_NOTE_LENGTH, normalizeNickname, normalizeUsername } from "../domain/validation";
import { BACKUP_FORMAT, CURRENT_BACKUP_VERSION, type BackupSnapshotV2 } from "./backupTypes";

/**
 * The extension's content security policy forbids `eval` and `new Function`. Zod asks the engine once, with `Function("")`, whether it
 * may compile parsers, and every schema below makes it ask. The engine says no and zod catches that, but the browser still reports a
 * `securitypolicyviolation` (the packaged Dashboard reported two in headless Edge; the final ZIP smoke test now looks for them). With
 * `jitless` zod skips the question and uses its ordinary parser, the one it falls back to here anyway. It has to be set before the
 * first schema is made, so it stays above all of them, and this is the only file that uses zod.
 */
z.config({ jitless: true });

/**
 * Primitive shape/type/enum validation only (Phase 3 §14). Cross-record
 * relationships (duplicate ids, merged-tombstone lineage, active+tombstone
 * exclusivity, ...) are a domain concern - see `validateBackupInvariants`.
 *
 * `z.iso.datetime()` (not a hand-rolled `Date.parse` check) because
 * `Date.parse` silently rolls an impossible calendar date like
 * "2026-02-30" over into a valid one (March 2) instead of rejecting it.
 */
/**
 * Exported so `validateCandidate.ts` (the final pre-commit gate) can reuse
 * this exact primitive rather than re-deriving an equivalent check that can
 * silently drift from it (Phase 3 review round 3, Medium #1) - e.g. a
 * hand-rolled `Date.parse`-based check, which unlike this accepts an
 * impossible calendar date like "2026-02-30" by rolling it over to March 2.
 */
export const isoTimestamp = z.iso.datetime({ message: "Invalid timestamp" });

/** Legacy non-UUID IDs remain valid, but imported storage keys cannot name prototype machinery. Shared with the final candidate gate. */
export const nonBlankId = z.string()
  .refine((value) => value.trim().length > 0, { message: "must not be blank" })
  .refine((value) => !["__proto__", "constructor", "prototype"].includes(value), { message: "reserved storage key" });

/**
 * Reuses the exact domain rule (`normalizeNickname`) rather than
 * re-deriving a length check: a nickname must already be in the same
 * trimmed, 1-25-visible-character form the app itself would produce, so
 * whitespace-only or leading/trailing-whitespace values are rejected, not
 * silently accepted or silently rewritten. Exported for the same reason as
 * `isoTimestamp`/`nonBlankId` above (Phase 3 review round 3, Medium #1):
 * checking only "does normalizeNickname throw" (as `validateCandidate.ts`
 * previously did) accepts `" Alice "` - it doesn't throw, it just isn't the
 * canonical value that would actually be stored.
 */
export const nicknameField = z.string().refine(
  (value) => {
    try {
      return normalizeNickname(value) === value;
    } catch {
      return false;
    }
  },
  { message: "Nickname must be a canonical (already-trimmed) 1-25 visible-character value" },
);

/**
 * Length-only, deliberately not canonicalized like nickname/username: a
 * note may legitimately contain meaningful leading/trailing whitespace
 * (Phase 3 §10), so this must never trim it to decide validity.
 */
const noteField = z
  .string()
  .refine((value) => countVisibleCharacters(value, MAX_NOTE_LENGTH) <= MAX_NOTE_LENGTH, {
    message: `Note must be ${MAX_NOTE_LENGTH} visible characters or fewer`,
  })
  .optional();

const requiredThreadsUserIdField = z
  .string()
  .regex(/^\d+$/, { message: "Threads user ID must contain ASCII digits only" });

const threadsUserIdField = requiredThreadsUserIdField.optional();

const usernameField = z.string().min(1).refine(
  (value) => {
    try {
      return normalizeUsername(value) === value;
    } catch {
      return false;
    }
  },
  { message: "Username must already be in canonical (normalized) form" },
);

/** Exported for the recovery reader (`src/recovery/recoveryImport.ts`), which holds each stored record to this same strict shape. */
export const ThreadContactSchema = z
  .object({
    id: nonBlankId,
    threadsUserId: threadsUserIdField,
    username: usernameField,
    nickname: nicknameField,
    note: noteField,
    createdAt: isoTimestamp,
    updatedAt: isoTimestamp,
    identityUpdatedAt: isoTimestamp,
  })
  .strict();

export const ContactTombstoneSchema = z
  .object({
    contactId: nonBlankId,
    threadsUserId: threadsUserIdField,
    username: usernameField,
    createdAt: isoTimestamp,
    deletedAt: isoTimestamp,
    reason: z.enum(["user_deleted", "merged"]),
    mergedIntoContactId: nonBlankId.optional(),
  })
  .strict();

/** Required, unlike a contact's own optional `threadsUserId` - the account that ran an export is always a known, confirmed account (Phase 3.5 Task 32, Phase 3.6 §4). */
const BackupExportedBySchema = z
  .object({
    threadsUserId: requiredThreadsUserIdField,
    username: usernameField,
  })
  .strict();

/**
 * `.strict()` throughout: an unrecognized field - most importantly a raw
 * `settings`/`identityCache`/`identityIndex`/`identityConflicts` dump that
 * would otherwise be silently stripped by zod's default object behavior -
 * rejects the whole backup instead of quietly passing through, per Phase 3
 * §16's "no partial import" contract applied to the file itself.
 */
export const BackupSnapshotV2Schema: z.ZodType<BackupSnapshotV2> = z
  .object({
    format: z.literal(BACKUP_FORMAT),
    backupVersion: z.literal(CURRENT_BACKUP_VERSION),
    exportedBy: BackupExportedBySchema,
    directoryId: nonBlankId,
    exportedAt: isoTimestamp,
    contacts: z.array(ThreadContactSchema),
    tombstones: z.array(ContactTombstoneSchema),
  })
  .strict();

/** Only the fields needed to detect the backup's declared version, before full schema validation. */
export const BackupVersionProbeSchema = z.object({
  format: z.string().optional(),
  backupVersion: z.number().optional(),
});
