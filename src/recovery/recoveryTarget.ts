import { countBindingsToDirectory } from "../domain/accountBindings";
import { validateCandidateSnapshot } from "../portability/validateCandidate";
import { isAlreadyCurrent, migrateStorage } from "../storage/migrations";
import { recoveryStateFor } from "./RecoveryCoordinator";
import { DIRECTORY_KEYS, type RecoveryCandidate, type RecoveryImportErrorCode, type RecoveryResult, type RecoverySource } from "./recoveryImport";
import { validateStorageHealth } from "./validateStorageHealth";

/** This account's binding and the raw record it points at, exactly as read. `null` for both when it has none. */
export interface RecoveryBaseline {
  binding: string | null;
  directory: unknown;
}

export interface RecoveryTarget {
  operation: "restore_empty" | "rebuild_damaged";
  baseline: RecoveryBaseline;
}

/** One analysis, held in the authorized page's memory only. The signal is the authority captured before the file was read. */
export interface RecoveryPreview {
  source: RecoverySource;
  candidate: RecoveryCandidate;
  target: RecoveryTarget;
  authoritySignal: AbortSignal;
}

const fail = (code: RecoveryImportErrorCode): { ok: false; code: RecoveryImportErrorCode } => ({ ok: false, code });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Stored JSON with its object keys sorted, so key order is not a difference while a missing field and a `null` one still are. */
function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(value, (_key, item: unknown) =>
    isRecord(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : item,
  );
  if (serialized === undefined) throw new Error("Invalid JSON value");
  return serialized;
}

/** Throws when a value cannot be serialized (too deep, say): callers turn that into a refusal, never into "equal". */
const sameJson = (a: unknown, b: unknown): boolean => (a === undefined || b === undefined ? a === b : canonicalJson(a) === canonicalJson(b));

function storageParts(raw: unknown): { directories: Record<string, unknown>; bindings: Record<string, unknown> } {
  const storage = isRecord(raw) ? raw : {};
  return {
    directories: isRecord(storage.directories) ? storage.directories : {},
    bindings: isRecord(storage.accountBindings) ? storage.accountBindings : {},
  };
}

function baselineOf(raw: unknown, owner: string): RecoveryBaseline {
  const { directories, bindings } = storageParts(raw);
  const binding = Object.hasOwn(bindings, owner) && typeof bindings[owner] === "string" ? (bindings[owner] as string) : null;
  return { binding, directory: binding !== null && Object.hasOwn(directories, binding) ? directories[binding] : null };
}

const sizeOf = (value: unknown) => (isRecord(value) ? Object.keys(value).length : 0);

/** The file's records, and nothing else a restore would drop. Derived data is not compared: it is rebuilt either way. */
function holdsExactly(directory: unknown, source: RecoverySource): boolean {
  return (
    isRecord(directory) &&
    Object.keys(directory).every((key) => DIRECTORY_KEYS.includes(key)) &&
    directory.directoryId === source.directoryId &&
    sameJson(directory.contacts, source.contacts) &&
    sameJson(directory.tombstones, source.tombstones)
  );
}

/**
 * Where `source` may be restored for its owner (spec section 7), from raw storage alone. Reads only.
 *
 * - This account's own Directory is in Recovery: only the Directory the file came from, still holding exactly the
 *   file's contacts and deleted records (compared value by value; key order aside, never by date), bound to no one
 *   else. Its index and conflicts are rebuilt.
 * - Otherwise: only an account with no Directory, or one that is truly empty - no contacts, no deleted records, no
 *   pending conflicts. Anything else is refused as it is: nothing is merged, overwritten, or cleared to make room.
 * - The file's Directory ID must not belong to any other Directory, bound or set aside or orphaned.
 * - Storage that is not current, or damaged beyond single Directories, is the existing flows' to handle.
 */
export function analyzeRecoveryTarget(raw: unknown, source: RecoverySource): RecoveryResult<RecoveryTarget> {
  try {
    if (!isAlreadyCurrent(raw) || validateStorageHealth(raw).kind === "global_error") return fail("unsupported_storage");
    const owner = source.ownerThreadsUserId;
    const { directories, bindings } = storageParts(raw);
    const baseline = baselineOf(raw, owner);

    if (recoveryStateFor(raw, owner).kind === "directory") {
      if (baseline.binding !== source.directoryId || !holdsExactly(baseline.directory, source)) return fail("source_target_mismatch");
      if (countBindingsToDirectory(bindings as Record<string, string>, source.directoryId) !== 1) return fail("directory_id_occupied");
      return { ok: true, value: { operation: "rebuild_damaged", baseline } };
    }

    if (baseline.binding !== source.directoryId && Object.hasOwn(directories, source.directoryId)) return fail("directory_id_occupied");
    const current = baseline.directory as Record<string, unknown> | null;
    if (current !== null && sizeOf(current.contacts) + sizeOf(current.tombstones) + sizeOf(current.identityConflicts) > 0) {
      return fail("target_not_empty");
    }
    return { ok: true, value: { operation: "restore_empty", baseline } };
  } catch {
    return fail("invalid_structure");
  }
}

/** Whether exactly this preview's candidate is what the account is bound to now: every value, not just its ID or counts. */
export function recoveryApplied(raw: unknown, preview: RecoveryPreview): boolean {
  try {
    const { binding, directory } = baselineOf(raw, preview.source.ownerThreadsUserId);
    return binding === preview.candidate.record.directoryId && sameJson(directory, preview.candidate.record);
  } catch {
    return false;
  }
}

/**
 * The single `set` a restore makes, composed from `raw` as it is now (spec T3, T5): every other Directory and binding
 * as currently stored - other accounts' newest data, set-aside Directories included - with only this account's
 * Directory replaced, or bound, and its own old empty Directory dropped when the file's has another ID. Never a clear.
 *
 * The preview is not a permission: this account's binding and Directory must be exactly as the preview saw them, the
 * target is analyzed again, and the candidate itself is checked again - valid, loadable, and the file's own records.
 */
export function prepareRecoveryWrite(
  raw: unknown,
  preview: RecoveryPreview,
): RecoveryResult<{ directories: Record<string, unknown>; accountBindings: Record<string, string> }> {
  try {
    const { source, candidate } = preview;
    const owner = source.ownerThreadsUserId;
    if (!sameJson(baselineOf(raw, owner), preview.target.baseline)) return fail("concurrent_change");
    const target = analyzeRecoveryTarget(raw, source);
    if (!target.ok) return target;

    const { record } = candidate;
    const valid = validateCandidateSnapshot({
      directoryId: record.directoryId,
      contacts: new Map(Object.entries(record.contacts)),
      tombstones: new Map(Object.entries(record.tombstones)),
    }).ok;
    try {
      migrateStorage({ schemaVersion: 4, directories: { [source.directoryId]: record }, accountBindings: { [owner]: source.directoryId } });
    } catch {
      return fail("invalid_records");
    }
    if (!valid || !sameJson(record.contacts, source.contacts) || !sameJson(record.tombstones, source.tombstones)) return fail("invalid_records");

    const { directories, bindings } = storageParts(raw);
    const nextDirectories: Record<string, unknown> = { ...directories };
    const previous = target.value.baseline.binding;
    // Only ever this account's own Directory, and only an empty one: a damaged Directory has the file's ID.
    if (previous !== null && previous !== source.directoryId) delete nextDirectories[previous];
    nextDirectories[source.directoryId] = record;
    return { ok: true, value: { directories: nextDirectories, accountBindings: { ...(bindings as Record<string, string>), [owner]: source.directoryId } } };
  } catch {
    return fail("invalid_structure");
  }
}
