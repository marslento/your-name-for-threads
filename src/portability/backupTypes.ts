import type { ThreadContact } from "../domain/contact";
import type { ContactTombstone } from "../domain/tombstone";

/**
 * The on-disk format tag, not a product name: every backup exported so far
 * carries this exact string and `parseBackup` rejects anything else, so
 * renaming it with the product would orphan them all.
 */
export const BACKUP_FORMAT = "threads-private-directory-backup" as const;
export const CURRENT_BACKUP_VERSION = 2 as const;

/** The Threads account that performed an export - provenance only (Phase 3.6 §4). */
export interface BackupExportedBy {
  threadsUserId: string;
  username: string;
}

/**
 * The portable JSON format, independent from `ExtensionStorageV4.schemaVersion`
 * (Phase 3 §6, Phase 3.5 Task 32). Only exportedBy + directoryId + contacts
 * + tombstones are portable durable data - settings/identityCache/
 * identityIndex/identityConflicts never appear here.
 *
 * `exportedBy` records WHICH Threads account ran this export - it is
 * provenance, not Directory ownership (Phase 3.6 §4). A Directory is never
 * modelled as belonging to one account: the storage model binds accounts to
 * directories (`accountBindings`), and a future Shared Directory feature may
 * bind several. Lineage decisions read it together with `directoryId`
 * (Phase 3.6 §6), never as "the owner of this data".
 *
 * V1 (pre-account-scoping) backups carried no such field and are rejected
 * as an unsupported development format (Task 32), not migrated. V2 backups
 * written before Phase 3.6 spelled this field `owner`; the format is
 * pre-release, so they are likewise rejected rather than migrated.
 */
export interface BackupSnapshotV2 {
  format: typeof BACKUP_FORMAT;
  backupVersion: typeof CURRENT_BACKUP_VERSION;

  exportedBy: BackupExportedBy;

  directoryId: string;
  exportedAt: string;

  contacts: ThreadContact[];
  tombstones: ContactTombstone[];
}
