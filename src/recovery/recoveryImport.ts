import type { ThreadContact } from "../domain/contact";
import { MAX_DIRECTORY_RECORDS, type DirectoryRecord } from "../domain/directory";
import { reconcileIdentityDerivedState } from "../domain/identityReconciliation";
import type { ContactTombstone } from "../domain/tombstone";
import { isValidThreadsUserId } from "../domain/validation";
import { ContactTombstoneSchema, isoTimestamp, nonBlankId, ThreadContactSchema } from "../portability/backupSchema";
import { MAX_BACKUP_FILE_BYTES } from "../portability/parseBackup";
import { validateCandidateSnapshot, type CandidateValidationIssue } from "../portability/validateCandidate";
import { CURRENT_RECOVERY_VERSION, RECOVERY_FORMAT } from "./exportRecoveryDump";
import { RECOVERY_CODES } from "./recoveryTypes";

/**
 * Why a recovery file was not read, or a restore did not happen (Recovery Restore 1.1.0, spec section 10). A closed
 * set: the UI explains each in the reader's language, and a diagnostic may carry nothing but a fixed event code.
 */
export type RecoveryImportErrorCode =
  | "invalid_json"
  | "unsupported_format"
  | "unsupported_version"
  | "unsupported_scope"
  | "file_too_large"
  | "too_many_records"
  | "invalid_structure"
  | "invalid_records"
  | "owner_mismatch"
  | "unsupported_storage"
  | "target_not_empty"
  | "source_target_mismatch"
  | "directory_id_occupied"
  | "concurrent_change"
  | "authority_revoked"
  | "lock_unavailable"
  | "storage_read_failed"
  | "storage_write_failed"
  | "verification_failed";

/** Where a record failed. `path` can hold stored record IDs: it is for the signed-in account's own page only, never diagnostics. */
export interface RecoveryIssue {
  path: string;
  code: "invalid_field" | "key_mismatch" | "duplicate_username" | "invalid_lineage";
}

export type RecoveryResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: RecoveryImportErrorCode; issueCount?: number; issues?: RecoveryIssue[] };

/** The durable content of one account's recovery file, every record checked. The derived index is kept only to be summarized. */
export interface RecoverySource {
  ownerThreadsUserId: string;
  exportedAt: string;
  directoryId: string;
  contacts: Record<string, ThreadContact>;
  tombstones: Record<string, ContactTombstone>;
  originalDerived: { identityIndex: unknown; identityConflicts: unknown };
}

export interface RecoverySummary {
  contacts: number;
  tombstones: number;
  rebuiltIndexEntries: number;
  rebuiltConflicts: number;
  /** `null` when the file's own derived data is not a record, so it cannot be counted - it is not 0. */
  originalIndexEntries: number | null;
  originalConflicts: number | null;
  identityMismatchCount: number;
}

export interface RecoveryCandidate {
  record: DirectoryRecord;
  summary: RecoverySummary;
  /** For the signed-in account's own preview only; never diagnostics or anything kept after the page. At most 20. */
  identityMismatches: Array<{ contactId: string; username: string; storedThreadsUserId?: string; indexedThreadsUserId: string }>;
}

/** Problems and identity mismatches listed on screen; the counts cover all of them. */
const LISTED = 20;
const MAX_PATH = 200;
const METADATA_KEYS = ["format", "recoveryVersion", "notice", "exportedAt", "extensionVersion", "scope", "code", "storage"];
const STORAGE_KEYS = ["schemaVersion", "directories", "accountBindings"];
/** Every field a stored Directory record has. Anything else would be dropped by a restore, so it is refused instead. */
export const DIRECTORY_KEYS = ["directoryId", "contacts", "tombstones", "identityIndex", "identityConflicts"];

const fail = (code: RecoveryImportErrorCode): { ok: false; code: RecoveryImportErrorCode } => ({ ok: false, code });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const hasExactly = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

const hasOnly = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key));

/** What the validator says about a stored record, as a path into the file: never the record's values. */
function fieldPath(collection: string, key: string, issue: { path: PropertyKey[]; keys?: unknown }): string {
  const unknownKeys = Array.isArray(issue.keys) ? issue.keys.map(String) : [];
  return [collection, key, ...issue.path.map(String), ...unknownKeys.slice(0, 1)].join(".");
}

function candidateIssue(issue: CandidateValidationIssue): RecoveryIssue {
  switch (issue.code) {
    case "duplicate_username":
      return { path: `contacts.${issue.contactId}.username`, code: "duplicate_username" };
    case "broken_merged_lineage":
    case "invalid_tombstone":
      return { path: `tombstones.${issue.contactId}.mergedIntoContactId`, code: "invalid_lineage" };
    case "active_and_tombstone_same_id":
      return { path: `tombstones.${issue.contactId}`, code: "invalid_lineage" };
    case "invalid_directory_id":
      return { path: "directoryId", code: "invalid_field" };
    default:
      // The strict record schemas already refuse everything else the final gate checks.
      return { path: issue.contactId, code: "invalid_field" };
  }
}

function readRecovery(json: unknown, owner: string): RecoveryResult<RecoverySource> {
  if (!isRecord(json) || json.format !== RECOVERY_FORMAT) return fail("unsupported_format");
  if (json.recoveryVersion !== CURRENT_RECOVERY_VERSION) return fail("unsupported_version");
  if (json.scope !== "directory") return fail("unsupported_scope");
  const storage = json.storage;
  if (!isRecord(storage)) return fail("invalid_structure");
  if (storage.schemaVersion !== 4) return fail("unsupported_version");

  // Only what a single-account recovery file holds, each of its own type: nothing of another account, no settings,
  // no identity cache. `code` and `notice` are data, never instructions.
  if (
    !hasExactly(json, METADATA_KEYS) ||
    typeof json.notice !== "string" ||
    !isoTimestamp.safeParse(json.exportedAt).success ||
    typeof json.extensionVersion !== "string" ||
    !(RECOVERY_CODES as readonly unknown[]).includes(json.code) ||
    !hasExactly(storage, STORAGE_KEYS)
  ) {
    return fail("invalid_structure");
  }
  const { directories, accountBindings } = storage;
  if (!isRecord(directories) || !isRecord(accountBindings)) return fail("invalid_structure");
  const directoryIds = Object.keys(directories);
  const owners = Object.keys(accountBindings);
  if (directoryIds.length !== 1 || owners.length !== 1) return fail("invalid_structure");
  const [directoryId] = directoryIds;
  const [boundOwner] = owners;
  const directory = directories[directoryId];
  // Missing or mistyped collections are not read as empty, and a field the format lacks is not silently dropped.
  if (!isRecord(directory) || !hasOnly(directory, DIRECTORY_KEYS) || !isRecord(directory.contacts) || !isRecord(directory.tombstones)) {
    return fail("invalid_structure");
  }
  const storedContacts = directory.contacts;
  const storedTombstones = directory.tombstones;
  // Counted before a single record is walked.
  if (Object.keys(storedContacts).length + Object.keys(storedTombstones).length > MAX_DIRECTORY_RECORDS) return fail("too_many_records");

  if (
    !isValidThreadsUserId(boundOwner) ||
    accountBindings[boundOwner] !== directoryId ||
    directory.directoryId !== directoryId ||
    !nonBlankId.safeParse(directoryId).success
  ) {
    return fail("invalid_structure");
  }
  // The binding in the file is unsigned: it can only ever agree with the account that is signed in now.
  if (boundOwner !== owner) return fail("owner_mismatch");

  const issues: RecoveryIssue[] = [];
  let issueCount = 0;
  const report = ({ path, code }: RecoveryIssue) => {
    issueCount += 1;
    if (issues.length < LISTED) issues.push({ path: path.length > MAX_PATH ? `${path.slice(0, MAX_PATH - 1)}…` : path, code });
  };
  const refused = () => ({ ok: false as const, code: "invalid_records" as const, issueCount, issues });

  for (const [key, value] of Object.entries(storedContacts)) {
    const checked = ThreadContactSchema.safeParse(value);
    if (!checked.success) for (const issue of checked.error.issues) report({ path: fieldPath("contacts", key, issue), code: "invalid_field" });
    else if (checked.data.id !== key) report({ path: `contacts.${key}.id`, code: "key_mismatch" });
  }
  for (const [key, value] of Object.entries(storedTombstones)) {
    const checked = ContactTombstoneSchema.safeParse(value);
    if (!checked.success) for (const issue of checked.error.issues) report({ path: fieldPath("tombstones", key, issue), code: "invalid_field" });
    else if (checked.data.contactId !== key) report({ path: `tombstones.${key}.contactId`, code: "key_mismatch" });
  }
  if (issueCount > 0) return refused();

  // Every record passed the strict schema, so each is exactly a contact or a deleted record: kept as stored, not
  // re-serialized by the validator. `fromEntries` defines keys as data.
  const contacts = Object.fromEntries(Object.entries(storedContacts).map(([key, value]) => [key, { ...(value as ThreadContact) }]));
  const tombstones = Object.fromEntries(Object.entries(storedTombstones).map(([key, value]) => [key, { ...(value as ContactTombstone) }]));
  const final = validateCandidateSnapshot({ directoryId, contacts: new Map(Object.entries(contacts)), tombstones: new Map(Object.entries(tombstones)) });
  if (!final.ok) {
    for (const issue of final.issues) report(candidateIssue(issue));
    return refused();
  }

  return {
    ok: true,
    value: {
      ownerThreadsUserId: owner,
      exportedAt: json.exportedAt as string,
      directoryId,
      contacts,
      tombstones,
      originalDerived: { identityIndex: directory.identityIndex, identityConflicts: directory.identityConflicts },
    },
  };
}

/**
 * Reads a single-account recovery file for `owner` (spec F1-F7). Every check comes before anything is written, and
 * any failure refuses the whole file: no record is trimmed, re-dated, skipped or repaired, and nothing is migrated.
 * The backup importer is unchanged and still refuses this format. Never throws; an unexpected validator failure is
 * a closed code, never its message.
 */
export function parseRecoveryText(text: string, owner: string): RecoveryResult<RecoverySource> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return fail("invalid_json");
  }
  try {
    return readRecovery(json, owner);
  } catch {
    return fail("invalid_structure");
  }
}

/** The size limit is checked before the file is read at all. */
export async function parseRecoveryFile(file: File, owner: string): Promise<RecoveryResult<RecoverySource>> {
  if (file.size > MAX_BACKUP_FILE_BYTES) return fail("file_too_large");
  return parseRecoveryText(await file.text(), owner);
}

/**
 * For the backup importer's refusal only (spec F7): whether the file it refused is a recovery file, so the person can
 * be pointed to the restore instead. It reads nothing further into anything and never throws.
 */
export async function isRecoveryFile(file: File): Promise<boolean> {
  if (file.size > MAX_BACKUP_FILE_BYTES) return false;
  try {
    const json: unknown = JSON.parse(await file.text());
    return isRecord(json) && json.format === RECOVERY_FORMAT;
  } catch {
    return false;
  }
}

const countOf = (value: unknown): number | null => (value === undefined ? 0 : isRecord(value) ? Object.keys(value).length : null);

/**
 * The Directory a restore would write (spec F4): the durable records exactly as read, and an index and pending
 * conflicts rebuilt from them. Contacts that share a stable ID get a new pending conflict; none is picked. Rebuilding
 * is not verifying who anyone is: an old index entry that names another ID is only reported, and each contact keeps
 * the ID it stored. Built once per preview, so a retry writes the same conflict IDs.
 */
export function buildRecoveryCandidate(source: RecoverySource, now: string): RecoveryResult<RecoveryCandidate> {
  const { identityIndex, identityConflicts } = reconcileIdentityDerivedState({
    contacts: new Map(Object.entries(source.contacts)),
    existingConflicts: new Map(),
    now,
  });

  const identityMismatches: RecoveryCandidate["identityMismatches"] = [];
  let identityMismatchCount = 0;
  const index = source.originalDerived.identityIndex;
  if (isRecord(index)) {
    for (const [key, target] of Object.entries(index)) {
      const indexedThreadsUserId = /^threads:(\d+)$/.exec(key)?.[1];
      const contact = typeof target === "string" && Object.hasOwn(source.contacts, target) ? source.contacts[target] : undefined;
      if (indexedThreadsUserId === undefined || contact === undefined || contact.threadsUserId === indexedThreadsUserId) continue;
      identityMismatchCount += 1;
      if (identityMismatches.length < LISTED) {
        identityMismatches.push({
          contactId: contact.id,
          username: contact.username,
          ...(contact.threadsUserId === undefined ? {} : { storedThreadsUserId: contact.threadsUserId }),
          indexedThreadsUserId,
        });
      }
    }
  }

  return {
    ok: true,
    value: {
      // Copies: what is written is checked against the file again at commit, so it must not be the file's own object.
      record: {
        directoryId: source.directoryId,
        contacts: structuredClone(source.contacts),
        tombstones: structuredClone(source.tombstones),
        identityIndex,
        identityConflicts,
      },
      summary: {
        contacts: Object.keys(source.contacts).length,
        tombstones: Object.keys(source.tombstones).length,
        rebuiltIndexEntries: Object.keys(identityIndex).length,
        rebuiltConflicts: Object.keys(identityConflicts).length,
        originalIndexEntries: countOf(source.originalDerived.identityIndex),
        originalConflicts: countOf(source.originalDerived.identityConflicts),
        identityMismatchCount,
      },
      identityMismatches,
    },
  };
}
