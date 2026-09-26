import type { ThreadContact } from "../domain/contact";
import type { ContactTombstone } from "../domain/tombstone";
import type { DirectorySnapshot } from "../domain/directorySnapshot";
import { MAX_DIRECTORY_RECORDS } from "../domain/directory";
import { MAX_BACKUP_FILE_BYTES } from "./parseBackup";
import { BackupSnapshotV2Schema } from "./backupSchema";
import { BACKUP_FORMAT, CURRENT_BACKUP_VERSION, type BackupExportedBy, type BackupSnapshotV2 } from "./backupTypes";
import { normalizeBackup } from "./normalizeBackup";
import { validateBackupInvariants, type BackupValidationIssue } from "./validateBackup";

function orderedContact(contact: ThreadContact): ThreadContact {
  return {
    id: contact.id,
    ...(contact.threadsUserId === undefined ? {} : { threadsUserId: contact.threadsUserId }),
    username: contact.username,
    nickname: contact.nickname,
    ...(contact.note === undefined ? {} : { note: contact.note }),
    createdAt: contact.createdAt,
    updatedAt: contact.updatedAt,
    identityUpdatedAt: contact.identityUpdatedAt,
  };
}

function orderedTombstone(tombstone: ContactTombstone): ContactTombstone {
  return {
    contactId: tombstone.contactId,
    ...(tombstone.threadsUserId === undefined ? {} : { threadsUserId: tombstone.threadsUserId }),
    username: tombstone.username,
    createdAt: tombstone.createdAt,
    deletedAt: tombstone.deletedAt,
    reason: tombstone.reason,
    ...(tombstone.mergedIntoContactId === undefined
      ? {}
      : { mergedIntoContactId: tombstone.mergedIntoContactId }),
  };
}

/**
 * `directory` only carries the portable durable fields (Phase 3 §7) - there
 * is no settings/identityCache/identityIndex/identityConflicts parameter to
 * accidentally pass through, so those can never leak into a backup. `owner`
 * must come from the caller's own confirmed session (Phase 3.5 Task 33) -
 * this function has no notion of "current account" itself.
 */
export function createBackupSnapshot(
  directory: DirectorySnapshot,
  exportedBy: BackupExportedBy,
  exportedAt: string,
): BackupSnapshotV2 {
  const contacts = [...directory.contacts.values()]
    .map(orderedContact)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const tombstones = [...directory.tombstones.values()]
    .map(orderedTombstone)
    .sort((a, b) => (a.contactId < b.contactId ? -1 : a.contactId > b.contactId ? 1 : 0));

  return {
    format: BACKUP_FORMAT,
    backupVersion: CURRENT_BACKUP_VERSION,
    exportedBy,
    directoryId: directory.directoryId,
    exportedAt,
    contacts,
    tombstones,
  };
}

/** Fixed key order + two-space indentation: for a fixed `exportedAt`, identical durable data serializes identically (Phase 3 §8). */
export function serializeBackup(backup: BackupSnapshotV2): string {
  return JSON.stringify(backup, null, 2);
}

export type ExportFailureReason =
  | { kind: "schema"; message: string }
  | { kind: "invariant"; issues: BackupValidationIssue[] };

export type ExportResult =
  | { ok: true; backup: BackupSnapshotV2; json: string; exceedsImportLimits?: true }
  | { ok: false; reason: ExportFailureReason };

/**
 * Export is fail-closed (Phase 3 §55): known-corrupt durable data is never
 * serialized. This must run the same primitive schema check `parseBackupText`
 * runs on import - otherwise a corrupt local record (e.g. a non-canonical
 * username, or a nickname that predates a validation tightening) could
 * produce a backup that "exports successfully" but can never be re-imported.
 * Valid legacy data above the import limits is still exported in full;
 * callers must display the restore warning when `exceedsImportLimits` is set.
 */
export function exportDirectory(directory: DirectorySnapshot, exportedBy: BackupExportedBy, exportedAt: string): ExportResult {
  const backup = normalizeBackup(createBackupSnapshot(directory, exportedBy, exportedAt));

  const schemaResult = BackupSnapshotV2Schema.safeParse(backup);
  if (!schemaResult.success) {
    return { ok: false, reason: { kind: "schema", message: schemaResult.error.message } };
  }

  const invariants = validateBackupInvariants(backup);
  if (!invariants.ok) {
    return { ok: false, reason: { kind: "invariant", issues: invariants.issues } };
  }

  const json = serializeBackup(backup);
  // Preserve all legacy data, but distinguish a downloaded copy from a file the importer can restore.
  const exceedsImportLimits = backup.contacts.length + backup.tombstones.length > MAX_DIRECTORY_RECORDS
    || new Blob([json]).size > MAX_BACKUP_FILE_BYTES;
  return { ok: true, backup, json, ...(exceedsImportLimits ? { exceedsImportLimits: true as const } : {}) };
}

/**
 * e.g. "2026-09-14T10:55:23.123Z" -> "your-name-for-threads-backup-2026-09-14T105523Z.json"
 * (Phase 3 §8, renamed with the product in Phase 4). Only the download name
 * follows the brand - the `format` tag inside the file is BACKUP_FORMAT, which
 * stays as it was so backups exported earlier still import.
 */
export function backupFilename(exportedAt: string): string {
  const compact = exportedAt.replace(/:/g, "").replace(/\.\d+Z$/, "Z");
  return `your-name-for-threads-backup-${compact}.json`;
}

/** Browser-only: triggers a local file download. Never touches the network. */
export function triggerBackupDownload(filename: string, json: string): void {
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
