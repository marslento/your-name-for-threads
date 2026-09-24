import { assertValidTombstone } from "../domain/tombstone";
import type { BackupSnapshotV2 } from "./backupTypes";

export type BackupValidationIssue =
  | { code: "duplicate_contact_id"; contactId: string }
  | { code: "duplicate_username"; contactId: string; username: string }
  | { code: "duplicate_tombstone_id"; contactId: string }
  | { code: "active_and_tombstone_same_id"; contactId: string }
  | { code: "invalid_tombstone"; contactId: string; message: string }
  | { code: "merged_tombstone_self_reference"; contactId: string }
  | { code: "broken_merged_lineage"; contactId: string; mergedIntoContactId: string };

export type BackupValidationResult =
  | { ok: true }
  | { ok: false; issues: BackupValidationIssue[] };

/**
 * Cross-record/semantic invariants only (Phase 3 §14) - primitive shape is
 * `BackupSnapshotV2Schema`'s job. Multiple active contacts sharing the same
 * `threadsUserId` are deliberately allowed here: Phase 2's IdentityConflict
 * mechanism is what reconciles that, not backup rejection (Phase 3 §6/§42).
 */
export function validateBackupInvariants(snapshot: BackupSnapshotV2): BackupValidationResult {
  const issues: BackupValidationIssue[] = [];

  const activeIds = new Set<string>();
  const activeUsernames = new Map<string, string>();
  for (const contact of snapshot.contacts) {
    if (activeIds.has(contact.id)) {
      issues.push({ code: "duplicate_contact_id", contactId: contact.id });
    }
    activeIds.add(contact.id);
    const usernameOwner = activeUsernames.get(contact.username);
    if (usernameOwner !== undefined && usernameOwner !== contact.id) {
      issues.push({ code: "duplicate_username", contactId: contact.id, username: contact.username });
    }
    activeUsernames.set(contact.username, contact.id);
  }

  const tombstoneIds = new Set<string>();
  for (const tombstone of snapshot.tombstones) {
    if (tombstoneIds.has(tombstone.contactId)) {
      issues.push({ code: "duplicate_tombstone_id", contactId: tombstone.contactId });
    }
    tombstoneIds.add(tombstone.contactId);

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

    if (tombstone.reason !== "merged") continue;

    const target = tombstone.mergedIntoContactId;
    if (!target) continue; // already reported above by assertValidTombstone

    if (target === tombstone.contactId) {
      issues.push({ code: "merged_tombstone_self_reference", contactId: tombstone.contactId });
      continue;
    }

    if (!activeIds.has(target)) {
      issues.push({
        code: "broken_merged_lineage",
        contactId: tombstone.contactId,
        mergedIntoContactId: target,
      });
    }
  }

  for (const contactId of activeIds) {
    if (tombstoneIds.has(contactId)) {
      issues.push({ code: "active_and_tombstone_same_id", contactId });
    }
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}
