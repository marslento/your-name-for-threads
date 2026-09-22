import { assertValidTombstone, type TombstoneReason } from "../domain/tombstone";
import { isValidThreadsUserId, normalizeNote, normalizeUsername } from "../domain/validation";
import type { DirectorySnapshot } from "../domain/directorySnapshot";
import { isoTimestamp, nicknameField, nonBlankId } from "./backupSchema";

const VALID_TOMBSTONE_REASONS: readonly TombstoneReason[] = ["user_deleted", "merged"];

export type CandidateValidationIssue =
  | { code: "invalid_directory_id" }
  | { code: "invalid_contact_id"; contactId: string }
  | { code: "invalid_nickname"; contactId: string }
  | { code: "invalid_note"; contactId: string }
  | { code: "invalid_username"; contactId: string }
  | { code: "invalid_threads_user_id"; contactId: string }
  | { code: "invalid_timestamp"; contactId: string }
  | { code: "active_and_tombstone_same_id"; contactId: string }
  | { code: "contact_map_key_mismatch"; contactId: string }
  | { code: "invalid_tombstone"; contactId: string; message: string }
  | { code: "invalid_tombstone_reason"; contactId: string }
  | { code: "tombstone_map_key_mismatch"; contactId: string }
  | { code: "broken_merged_lineage"; contactId: string };

function isCanonicalUsername(value: string): boolean {
  try {
    return normalizeUsername(value) === value;
  } catch {
    return false;
  }
}

export type CandidateValidationResult = { ok: true } | { ok: false; issues: CandidateValidationIssue[] };

/**
 * Reuses the exact same primitives `backupSchema.ts` validates an imported
 * file against (Phase 3 review round 3, Medium #1), so this final pre-commit
 * gate can never be looser than what a backup file itself is required to
 * satisfy - a `Date.parse`-based timestamp check or a "does normalizeNickname
 * throw" nickname check both previously accepted values the schema already
 * rejects (an impossible calendar date, a non-canonical " Alice " nickname).
 */
function isValidTimestamp(value: string): boolean {
  return isoTimestamp.safeParse(value).success;
}

function isNonBlank(value: string): boolean {
  return nonBlankId.safeParse(value).success;
}

function isCanonicalNickname(value: string): boolean {
  return nicknameField.safeParse(value).success;
}

/**
 * The last gate before commit (Phase 3 §42), run on an already successfully
 * built candidate. Multiple active contacts sharing a `threadsUserId` are
 * deliberately not checked here - Phase 2's IdentityConflict mechanism
 * handles that, not candidate rejection.
 */
export function validateCandidateSnapshot(candidate: DirectorySnapshot): CandidateValidationResult {
  const issues: CandidateValidationIssue[] = [];

  if (!isNonBlank(candidate.directoryId)) {
    issues.push({ code: "invalid_directory_id" });
  }

  for (const [key, contact] of candidate.contacts) {
    if (!isNonBlank(contact.id)) {
      issues.push({ code: "invalid_contact_id", contactId: contact.id });
    }
    if (key !== contact.id) {
      issues.push({ code: "contact_map_key_mismatch", contactId: contact.id });
    }
    if (!isCanonicalNickname(contact.nickname)) {
      issues.push({ code: "invalid_nickname", contactId: contact.id });
    }
    if (contact.note !== undefined) {
      try {
        normalizeNote(contact.note);
      } catch {
        issues.push({ code: "invalid_note", contactId: contact.id });
      }
    }
    if (
      !isValidTimestamp(contact.createdAt) ||
      !isValidTimestamp(contact.updatedAt) ||
      !isValidTimestamp(contact.identityUpdatedAt)
    ) {
      issues.push({ code: "invalid_timestamp", contactId: contact.id });
    }
    if (candidate.tombstones.has(contact.id)) {
      issues.push({ code: "active_and_tombstone_same_id", contactId: contact.id });
    }
    if (!isCanonicalUsername(contact.username)) {
      issues.push({ code: "invalid_username", contactId: contact.id });
    }
    if (contact.threadsUserId !== undefined && !isValidThreadsUserId(contact.threadsUserId)) {
      issues.push({ code: "invalid_threads_user_id", contactId: contact.id });
    }
  }

  for (const [key, tombstone] of candidate.tombstones) {
    if (!isNonBlank(tombstone.contactId)) {
      issues.push({ code: "invalid_contact_id", contactId: tombstone.contactId });
    }
    if (key !== tombstone.contactId) {
      issues.push({ code: "tombstone_map_key_mismatch", contactId: tombstone.contactId });
    }
    if (!isCanonicalUsername(tombstone.username)) {
      issues.push({ code: "invalid_username", contactId: tombstone.contactId });
    }
    if (tombstone.threadsUserId !== undefined && !isValidThreadsUserId(tombstone.threadsUserId)) {
      issues.push({ code: "invalid_threads_user_id", contactId: tombstone.contactId });
    }
    if (!VALID_TOMBSTONE_REASONS.includes(tombstone.reason)) {
      issues.push({ code: "invalid_tombstone_reason", contactId: tombstone.contactId });
    }

    try {
      assertValidTombstone(tombstone);
    } catch (error) {
      issues.push({
        code: "invalid_tombstone",
        contactId: tombstone.contactId,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (!isValidTimestamp(tombstone.createdAt) || !isValidTimestamp(tombstone.deletedAt)) {
      issues.push({ code: "invalid_timestamp", contactId: tombstone.contactId });
    }

    if (
      tombstone.reason === "merged" &&
      tombstone.mergedIntoContactId !== undefined &&
      !candidate.contacts.has(tombstone.mergedIntoContactId)
    ) {
      issues.push({ code: "broken_merged_lineage", contactId: tombstone.contactId });
    }
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}
