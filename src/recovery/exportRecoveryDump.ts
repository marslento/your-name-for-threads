import { triggerBackupDownload } from "../portability/exportBackup";
import { PHASE_ONE_VERSION } from "../shared/constants";
import { recoveryStateFor } from "./RecoveryCoordinator";
import type { RecoveryCode } from "./recoveryTypes";

/**
 * A Recovery dump is not a Backup (Phase 4 Task 20, design summary section 19). It is the raw stored data,
 * kept exactly as it is so a person or a developer can look at it and so nothing is lost before damaged
 * data is cleared. Its top-level `format` is different from a Backup's, and the Backup importer rejects
 * it on that alone (`parseBackupText`), so a dump can never be mistaken for one, restored from, or merged.
 * There is no importer for it and, in v1.0, no repair: nothing in the extension reads this format back.
 */
export const RECOVERY_FORMAT = "your-name-for-threads-recovery" as const;
export const CURRENT_RECOVERY_VERSION = 1 as const;

export interface RecoveryDump {
  format: typeof RECOVERY_FORMAT;
  recoveryVersion: typeof CURRENT_RECOVERY_VERSION;
  notice: string;
  exportedAt: string;
  extensionVersion: string;
  scope: "directory" | "global";
  code: RecoveryCode;
  /**
   * Exactly what was stored: not validated, not normalized, not repaired. For one damaged Directory it is
   * that account's Directory record and its binding, and nothing of anyone else's. When the root of
   * storage is damaged nothing can be scoped, so it is all of storage.
   */
  storage: unknown;
}

const NOTICE = "This file may contain private nicknames, notes and internal identifiers. Do not post it publicly.";

/**
 * The dump for whatever `owner` is in Recovery for, or `null` when nothing is: there is nothing to export
 * for an account whose data is fine. Pure, and it reads only.
 */
export function createRecoveryDump(input: { raw: unknown; ownerThreadsUserId: string | null; exportedAt: string }): RecoveryDump | null {
  const { raw, ownerThreadsUserId, exportedAt } = input;
  const state = recoveryStateFor(raw, ownerThreadsUserId);
  if (state.kind === "none") return null;

  const header = { format: RECOVERY_FORMAT, recoveryVersion: CURRENT_RECOVERY_VERSION, notice: NOTICE, exportedAt, extensionVersion: PHASE_ONE_VERSION, code: state.code } as const;
  if (state.kind === "global") return { ...header, scope: "global", storage: raw };

  // Directory scope: `recoveryStateFor` only says "directory" for an account bound to a Directory the loader
  // rejects, so both are there. Only that account's own Directory goes into its dump.
  const source = raw as { schemaVersion?: unknown; directories: Record<string, unknown>; accountBindings: Record<string, string> };
  const directoryId = source.accountBindings[ownerThreadsUserId as string];
  return {
    ...header,
    scope: "directory",
    storage: {
      schemaVersion: source.schemaVersion,
      directories: { [directoryId]: source.directories[directoryId] },
      accountBindings: { [ownerThreadsUserId as string]: directoryId },
    },
  };
}

export function serializeRecoveryDump(dump: RecoveryDump): string {
  return JSON.stringify(dump, null, 2);
}

/** e.g. "2026-09-16T13:45:00.000Z" -> "your-name-for-threads-recovery-2026-09-16T134500Z.json" */
export function recoveryDumpFilename(exportedAt: string): string {
  const compact = exportedAt.replace(/:/g, "").replace(/\.\d+Z$/, "Z");
  return `${RECOVERY_FORMAT}-${compact}.json`;
}

/**
 * Reads storage once and saves the dump to a file the person chooses. Nothing is sent anywhere, nothing is
 * kept, and nothing in storage is changed. `false` when there is nothing to export or storage cannot be
 * read; it never throws.
 */
export async function runRecoveryExport(ownerThreadsUserId: string | null, clock: () => string = () => new Date().toISOString(), signal?: AbortSignal): Promise<boolean> {
  try {
    signal?.throwIfAborted();
    const dump = createRecoveryDump({ raw: await chrome.storage.local.get(), ownerThreadsUserId, exportedAt: clock() });
    signal?.throwIfAborted();
    if (!dump) return false;
    triggerBackupDownload(recoveryDumpFilename(dump.exportedAt), serializeRecoveryDump(dump));
    return true;
  } catch {
    return false;
  }
}
