import { BACKUP_FORMAT, CURRENT_BACKUP_VERSION, type BackupSnapshotV2 } from "./backupTypes";
import { BackupSnapshotV2Schema, BackupVersionProbeSchema } from "./backupSchema";
import { normalizeBackup } from "./normalizeBackup";
import { PortabilityError } from "./portabilityErrors";
import { validateBackupInvariants } from "./validateBackup";

export const MAX_BACKUP_FILE_BYTES = 10 * 1024 * 1024;

export type ParseBackupResult =
  | { ok: true; backup: BackupSnapshotV2 }
  | { ok: false; error: PortabilityError };

/**
 * Full Phase 3 import pipeline up to a trusted, normalized backup (Phase 3
 * §13): parse JSON -> detect version -> schema validation (which alone
 * rejects any version but the current one - V1 had no migration path
 * defined and is dropped, Phase 3.5 Task 32) -> normalize -> invariant
 * validation. Any failure rejects the whole file - no partial import
 * (Phase 3 §16).
 */
export function parseBackupText(text: string): ParseBackupResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: new PortabilityError("invalid_json", "The file is not valid JSON.") };
  }

  const probe = BackupVersionProbeSchema.safeParse(json);
  if (!probe.success || probe.data.format !== BACKUP_FORMAT) {
    return {
      ok: false,
      error: new PortabilityError("invalid_format", "This file is not a Your Name for Threads backup."),
    };
  }

  if (typeof probe.data.backupVersion !== "number") {
    return {
      ok: false,
      error: new PortabilityError("invalid_format", "This file is not a Your Name for Threads backup."),
    };
  }

  if (probe.data.backupVersion > CURRENT_BACKUP_VERSION) {
    return {
      ok: false,
      error: new PortabilityError(
        "newer_version",
        "This backup was created by a newer version of Your Name for Threads.",
      ),
    };
  }

  // An older backupVersion (V1, pre-account-scoping) is rejected outright as
  // an unsupported development format (Phase 3.5 Task 32), not migrated -
  // it never shipped and carries no `owner`, so there is nothing safe to
  // migrate it into. Falls through to the generic "not a valid backup"
  // schema-validation failure below, same as any other malformed file.

  const parsed = BackupSnapshotV2Schema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      error: new PortabilityError("invalid_schema", "This backup failed schema validation."),
    };
  }

  const normalized = normalizeBackup(parsed.data);

  const invariants = validateBackupInvariants(normalized);
  if (!invariants.ok) {
    return {
      ok: false,
      error: new PortabilityError("invalid_invariant", "This backup failed invariant validation."),
    };
  }

  return { ok: true, backup: normalized };
}

/** Defensive Phase 3 file-size limit (§15), enforced before the (comparatively expensive) parse. */
export async function parseBackupFile(file: File): Promise<ParseBackupResult> {
  if (file.size > MAX_BACKUP_FILE_BYTES) {
    return {
      ok: false,
      error: new PortabilityError("file_too_large", "This backup file is larger than 10 MB."),
    };
  }

  const text = await file.text();
  return parseBackupText(text);
}
