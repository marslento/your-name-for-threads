import type { ThreadContact } from "../domain/contact";
import type { ContactTombstone, TombstoneReason } from "../domain/tombstone";
import type { DirectorySnapshot } from "../domain/directorySnapshot";
import { contactsEqual, tombstonesEqual } from "./analyzeImport";
import type { BackupSnapshotV2 } from "./backupTypes";
import { buildExternalMatchIndexes, classifyExternalContact } from "./externalMatching";
import type { ExternalMatch, ImportMode } from "./importTypes";

type RecordPresence =
  | { kind: "absent" }
  | { kind: "active"; updatedAt: string; identityUpdatedAt: string }
  | { kind: "tombstone"; deletedAt: string; reason: TombstoneReason; mergedIntoContactId?: string };

function presenceOf(id: string, snapshot: DirectorySnapshot): RecordPresence {
  const contact = snapshot.contacts.get(id);
  if (contact) return { kind: "active", updatedAt: contact.updatedAt, identityUpdatedAt: contact.identityUpdatedAt };
  const tombstone = snapshot.tombstones.get(id);
  if (tombstone) {
    return { kind: "tombstone", deletedAt: tombstone.deletedAt, reason: tombstone.reason, mergedIntoContactId: tombstone.mergedIntoContactId };
  }
  return { kind: "absent" };
}

function presenceEqual(a: RecordPresence, b: RecordPresence): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "active" && b.kind === "active") {
    return a.updatedAt === b.updatedAt && a.identityUpdatedAt === b.identityUpdatedAt;
  }
  if (a.kind === "tombstone" && b.kind === "tombstone") {
    return a.deletedAt === b.deletedAt && a.reason === b.reason && a.mergedIntoContactId === b.mergedIntoContactId;
  }
  return true; // both absent
}

/**
 * Beyond the match `kind` and which local record it targets, this holds a
 * full copy of that matched contact/tombstone at analysis time - so a
 * content-only edit (nickname, note, username, ...) during review is caught
 * even when the id and classification bucket stay the same, not just an id
 * or kind change.
 */
interface ExternalMatchSignature {
  kind: ExternalMatch["kind"];
  matchedContact?: ThreadContact;
  matchedTombstone?: ContactTombstone;
}

function signatureOf(match: ExternalMatch): ExternalMatchSignature {
  if (match.kind === "locally_deleted") return { kind: match.kind, matchedTombstone: match.tombstone };
  if (match.kind === "broken_merged_lineage") return { kind: match.kind, matchedTombstone: match.tombstone };
  // "new_contact" and "ambiguous_local_identity" both have no single local
  // record to fingerprint (the latter by definition - that's what makes it
  // ambiguous); the `kind` comparison alone still catches the ambiguity
  // resolving into some other match kind between baseline and commit.
  if (match.kind === "new_contact" || match.kind === "ambiguous_local_identity") return { kind: match.kind };
  return { kind: match.kind, matchedContact: match.local };
}

function signatureEqual(a: ExternalMatchSignature, b: ExternalMatchSignature): boolean {
  if (a.kind !== b.kind) return false;
  if (a.matchedContact || b.matchedContact) {
    return (
      a.matchedContact !== undefined &&
      b.matchedContact !== undefined &&
      a.matchedContact.id === b.matchedContact.id &&
      contactsEqual(a.matchedContact, b.matchedContact)
    );
  }
  if (a.matchedTombstone || b.matchedTombstone) {
    return (
      a.matchedTombstone !== undefined &&
      b.matchedTombstone !== undefined &&
      a.matchedTombstone.contactId === b.matchedTombstone.contactId &&
      tombstonesEqual(a.matchedTombstone, b.matchedTombstone)
    );
  }
  return true; // both "new_contact" - nothing local was matched at all
}

export type ImportConcurrencyBaseline =
  | { mode: "restore"; directoryId: string; records: Map<string, RecordPresence> }
  | { mode: "self_merge"; directoryId: string; records: Map<string, RecordPresence> }
  | { mode: "external_import"; directoryId: string; matches: Map<string, ExternalMatchSignature> };

export type ConcurrencyCheckResult = { ok: true } | { ok: false; reason: string };

/**
 * Captures exactly what the analysis for this `mode` depended on (Phase 3
 * §49) - not a global "directory changed" lock. Self Merge tracks every id
 * the incoming backup mentions, whether or not it already existed locally
 * (a new local record can later occupy that same id - e.g. via
 * resurrection - which must not be missed just because it was absent at
 * analysis time). External Import tracks each incoming contact's full match
 * classification, since a newly-appearing local contact can change which
 * bucket an incoming contact falls into. Restore replaces the whole
 * snapshot, so every id on EITHER side is part of what the Preflight's
 * counts were computed from - a contact added locally during review would
 * silently be dropped by the commit without ever having been counted as
 * "will be removed" (Phase 3.6 §9), so the baseline spans local ids too,
 * not just the ones the backup mentions. That subsumes the old
 * pristine-only "local stays empty" check: for an empty local Directory
 * every id is an incoming one, and a pending identity conflict cannot
 * appear without a contact appearing with it.
 */
export function captureConcurrencyBaseline(
  mode: ImportMode,
  local: DirectorySnapshot,
  incoming: BackupSnapshotV2,
): ImportConcurrencyBaseline {
  if (mode === "restore" || mode === "self_merge") {
    const mentioned = new Set<string>();
    for (const contact of incoming.contacts) mentioned.add(contact.id);
    for (const tombstone of incoming.tombstones) mentioned.add(tombstone.contactId);
    if (mode === "restore") {
      for (const id of local.contacts.keys()) mentioned.add(id);
      for (const id of local.tombstones.keys()) mentioned.add(id);
    }

    const records = new Map<string, RecordPresence>();
    for (const id of mentioned) records.set(id, presenceOf(id, local));
    return { mode, directoryId: local.directoryId, records };
  }

  const indexes = buildExternalMatchIndexes(local);
  const matches = new Map<string, ExternalMatchSignature>();
  for (const incomingContact of incoming.contacts) {
    matches.set(incomingContact.id, signatureOf(classifyExternalContact(incomingContact, indexes)));
  }
  return { mode: "external_import", directoryId: local.directoryId, matches };
}

/**
 * Re-derives, from `latest`, exactly what `captureConcurrencyBaseline`
 * recorded, and blocks the commit if any of it no longer matches. A
 * completely unrelated local change (one that isn't part of what the
 * baseline tracked at all) never blocks.
 */
export function checkImportConcurrency(
  baseline: ImportConcurrencyBaseline,
  latest: DirectorySnapshot,
  incoming: BackupSnapshotV2,
): ConcurrencyCheckResult {
  if (baseline.directoryId !== latest.directoryId) {
    return { ok: false, reason: "directory_changed" };
  }

  if (baseline.mode === "restore" || baseline.mode === "self_merge") {
    for (const [id, expected] of baseline.records) {
      if (!presenceEqual(expected, presenceOf(id, latest))) {
        return { ok: false, reason: "records_changed" };
      }
    }
    // A record that appeared locally while the user was deciding is part of
    // what Restore would silently discard, so it must block the commit even
    // though the baseline never mentioned its id.
    if (baseline.mode === "restore") {
      for (const id of [...latest.contacts.keys(), ...latest.tombstones.keys()]) {
        if (!baseline.records.has(id)) return { ok: false, reason: "records_changed" };
      }
    }
    return { ok: true };
  }

  const indexes = buildExternalMatchIndexes(latest);
  for (const incomingContact of incoming.contacts) {
    const expected = baseline.matches.get(incomingContact.id);
    const current = signatureOf(classifyExternalContact(incomingContact, indexes));
    if (!expected || !signatureEqual(expected, current)) {
      return { ok: false, reason: "matches_changed" };
    }
  }
  return { ok: true };
}
