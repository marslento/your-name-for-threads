import type { ThreadContact } from "../domain/contact";
import type { ContactTombstone } from "../domain/tombstone";
import type { DirectorySnapshot } from "../domain/directorySnapshot";
import { reconcileIdentityDerivedState } from "../domain/identityReconciliation";
import type { BackupSnapshotV2 } from "./backupTypes";
import { buildExternalMatchIndexes, classifyExternalContact, findDuplicateTargets } from "./externalMatching";
import type {
  ExternalDuplicateStrategy,
  ExternalMatch,
  ImportPreflight,
  ImportPreflightItem,
  ImportPreflightItemKind,
  ImportPreflightSummary,
  SelfMergeRecordSide,
  SelfMergeReviewIssue,
} from "./importTypes";
import { analyzeActiveActivePair, mergeContactRecord } from "./selfMerge";

function emptySummary(): ImportPreflightSummary {
  return {
    create: 0,
    update: 0,
    delete: 0,
    unchanged: 0,
    keptLocalNewer: 0,
    keptLocalDeletion: 0,
    stableDuplicates: 0,
    weakDuplicates: 0,
    identityMismatches: 0,
    locallyDeleted: 0,
    ambiguous: 0,
    pendingIdentityConflictsAfterImport: 0,
  };
}

function backupSummary(incoming: BackupSnapshotV2): ImportPreflight["backup"] {
  return {
    exportedAt: incoming.exportedAt,
    contactCount: incoming.contacts.length,
    tombstoneCount: incoming.tombstones.length,
  };
}

function countPredictedConflicts(contacts: ReadonlyMap<string, ThreadContact>, now: string): number {
  return Object.keys(
    reconcileIdentityDerivedState({ contacts, existingConflicts: new Map(), now }).identityConflicts,
  ).length;
}

export function contactsEqual(a: ThreadContact, b: ThreadContact): boolean {
  return (
    a.username === b.username &&
    a.nickname === b.nickname &&
    (a.note ?? undefined) === (b.note ?? undefined) &&
    a.createdAt === b.createdAt &&
    a.updatedAt === b.updatedAt &&
    a.identityUpdatedAt === b.identityUpdatedAt &&
    (a.threadsUserId ?? undefined) === (b.threadsUserId ?? undefined)
  );
}

export function tombstonesEqual(a: ContactTombstone, b: ContactTombstone): boolean {
  return (
    a.username === b.username &&
    (a.threadsUserId ?? undefined) === (b.threadsUserId ?? undefined) &&
    a.createdAt === b.createdAt &&
    a.deletedAt === b.deletedAt &&
    a.reason === b.reason &&
    (a.mergedIntoContactId ?? undefined) === (b.mergedIntoContactId ?? undefined)
  );
}

function sidesEqual(a: SelfMergeRecordSide, b: SelfMergeRecordSide): boolean {
  if (a.type === "active" && b.type === "active") return contactsEqual(a.contact, b.contact);
  if (a.type === "tombstone" && b.type === "tombstone") return tombstonesEqual(a.tombstone, b.tombstone);
  return false;
}

/**
 * Merge's own outcome vocabulary (Phase 3.6 §14). "Local won" is reported as
 * its own outcome rather than folded into "unchanged": both leave the
 * Directory looking the same afterwards, but only one of them means the
 * import had something to say and the local side overruled it - which is
 * exactly the behaviour §11/§12 promise and a reader of the Preflight needs
 * to be able to confirm.
 */
function categorizeSelfMergeOutcome(
  local: SelfMergeRecordSide,
  incoming: SelfMergeRecordSide,
  final: SelfMergeRecordSide,
): "update" | "delete" | "unchanged" | "keptLocalNewer" | "keptLocalDeletion" {
  if (sidesEqual(local, final)) {
    if (sidesEqual(local, incoming)) return "unchanged";
    if (local.type === "tombstone" && incoming.type === "active") return "keptLocalDeletion";
    return "keptLocalNewer";
  }
  if (local.type === "active" && final.type === "tombstone") return "delete";
  return "update";
}

function reviewItem(issue: SelfMergeReviewIssue): ImportPreflightItem {
  const dimension =
    issue.kind === "active_active_private_data"
      ? "private"
      : issue.kind === "active_active_identity_snapshot"
        ? "identity"
        : "lifecycle";
  const kind: ImportPreflightItemKind =
    issue.kind === "active_active_private_data"
      ? "review_private_data"
      : issue.kind === "active_active_identity_snapshot"
        ? "review_identity_snapshot"
        : "review_lifecycle";

  return {
    itemId: `contact:${issue.contactId}:${dimension}`,
    contactId: issue.contactId,
    kind,
    requiresDecision: true,
  };
}

/**
 * Self Merge is set union + version resolution, never "replace with backup"
 * (Phase 3 §30). A record on only one side is never touched by
 * `mergeContactRecord` - it simply survives (local-only) or is added
 * (incoming-only).
 */
export function analyzeSelfMerge(local: DirectorySnapshot, incoming: BackupSnapshotV2): ImportPreflight {
  const incomingContactsById = new Map(incoming.contacts.map((contact) => [contact.id, contact]));
  const incomingTombstonesById = new Map(incoming.tombstones.map((tombstone) => [tombstone.contactId, tombstone]));

  const allIds = new Set<string>([
    ...local.contacts.keys(),
    ...local.tombstones.keys(),
    ...incomingContactsById.keys(),
    ...incomingTombstonesById.keys(),
  ]);

  const summary = emptySummary();
  const items: ImportPreflightItem[] = [];
  const blockingIssues: ImportPreflight["blockingIssues"] = [];
  const predictedActiveContacts = new Map<string, ThreadContact>();

  function sideOf(id: string, contacts: ReadonlyMap<string, ThreadContact>, tombstones: ReadonlyMap<string, ContactTombstone>): SelfMergeRecordSide | undefined {
    const contact = contacts.get(id);
    if (contact) return { type: "active", contact };
    const tombstone = tombstones.get(id);
    if (tombstone) return { type: "tombstone", tombstone };
    return undefined;
  }

  for (const id of allIds) {
    const localSide = sideOf(id, local.contacts, local.tombstones);
    const incomingSide = sideOf(id, incomingContactsById, incomingTombstonesById);

    if (!incomingSide) {
      summary.unchanged += 1;
      if (localSide?.type === "active") predictedActiveContacts.set(id, localSide.contact);
      continue;
    }
    if (!localSide) {
      summary.create += 1;
      if (incomingSide.type === "active") predictedActiveContacts.set(id, incomingSide.contact);
      continue;
    }

    if (localSide.type === "active" && incomingSide.type === "active") {
      const analysis = analyzeActiveActivePair(localSide.contact, incomingSide.contact);
      if (analysis.blockingIssue) {
        blockingIssues.push(analysis.blockingIssue);
        predictedActiveContacts.set(id, localSide.contact);
        continue;
      }
      if (analysis.reviewIssues.length > 0) {
        summary.ambiguous += analysis.reviewIssues.length;
        for (const issue of analysis.reviewIssues) items.push(reviewItem(issue));
        predictedActiveContacts.set(id, localSide.contact);
        continue;
      }
      const finalContact = analysis.resolvedContact!;
      predictedActiveContacts.set(id, finalContact);
      summary[categorizeSelfMergeOutcome(localSide, incomingSide, { type: "active", contact: finalContact })] += 1;
      continue;
    }

    const resolution = mergeContactRecord(localSide, incomingSide);
    if (resolution.kind === "blocking") {
      blockingIssues.push(resolution.issue);
      if (localSide.type === "active") predictedActiveContacts.set(id, localSide.contact);
      continue;
    }
    if (resolution.kind === "review") {
      summary.ambiguous += 1;
      items.push(reviewItem(resolution.issue));
      if (localSide.type === "active") predictedActiveContacts.set(id, localSide.contact);
      continue;
    }

    if (resolution.result.type === "active") predictedActiveContacts.set(id, resolution.result.contact);
    summary[categorizeSelfMergeOutcome(localSide, incomingSide, resolution.result)] += 1;
  }

  summary.pendingIdentityConflictsAfterImport = countPredictedConflicts(predictedActiveContacts, incoming.exportedAt);

  return { mode: "self_merge", backup: backupSummary(incoming), summary, items, blockingIssues };
}

/**
 * The only collision Preflight itself can already know about, before any
 * review decision exists: a Stable Duplicate under the global `use_incoming`
 * strategy applies automatically to every match of that kind, so two
 * incoming records sharing the same local target are guaranteed to collide
 * however review plays out. Everything else - `keep_local` (writes
 * nothing), `review_each` (decision not made yet), and Weak
 * Duplicate/Locally Deleted (always require their own per-item decision
 * regardless of `strategy`) - has no knowable target yet, so it must not be
 * blocked here; it becomes a normal review item instead (Phase 3 review
 * round 3 -> round 4 follow-up: the original decision-blind version of this
 * check blocked even safe combinations like two Stable Duplicates both
 * bound for `keep_local`).
 */
function preflightWriteTarget(match: ExternalMatch, strategy: ExternalDuplicateStrategy): string | null {
  if (match.kind === "stable_duplicate" && strategy === "use_incoming") return match.local.id;
  return null;
}

/**
 * Incoming tombstones are validated (upstream, by `validateBackupInvariants`)
 * but never applied here - a different `directoryId`'s deletion history
 * belongs to that directory, not this one (Phase 3 §28).
 */
export function analyzeExternalImport(
  local: DirectorySnapshot,
  incoming: BackupSnapshotV2,
  strategy: ExternalDuplicateStrategy = "review_each",
): ImportPreflight {
  const indexes = buildExternalMatchIndexes(local);
  const summary = emptySummary();
  const items: ImportPreflightItem[] = [];
  const blockingIssues: ImportPreflight["blockingIssues"] = [];
  const predictedActiveContacts = new Map<string, ThreadContact>(local.contacts);

  const matches = incoming.contacts.map((incomingContact) => classifyExternalContact(incomingContact, indexes));
  const duplicateTargets = findDuplicateTargets(matches.map((match) => preflightWriteTarget(match, strategy)));

  for (let i = 0; i < incoming.contacts.length; i += 1) {
    const incomingContact = incoming.contacts[i];
    const match = matches[i];

    const writeTarget = preflightWriteTarget(match, strategy);
    if (writeTarget !== null && duplicateTargets.has(writeTarget)) {
      blockingIssues.push({
        code: "duplicate_import_target",
        contactId: writeTarget,
        message: `More than one contact in this backup would write to local contact ${writeTarget} - resolve the duplicate in the backup before importing.`,
      });
      continue;
    }

    switch (match.kind) {
      case "new_contact": {
        summary.create += 1;
        items.push({
          itemId: `external:${incomingContact.id}:new`,
          contactId: incomingContact.id,
          kind: "external_new",
          requiresDecision: false,
        });
        predictedActiveContacts.set(`external-new:${incomingContact.id}`, incomingContact);
        break;
      }
      case "stable_duplicate": {
        summary.stableDuplicates += 1;
        const requiresDecision = strategy === "review_each";
        if (requiresDecision) summary.ambiguous += 1;
        items.push({
          itemId: `external:${incomingContact.id}:stable`,
          contactId: match.local.id,
          kind: "external_stable_duplicate",
          requiresDecision,
        });
        break;
      }
      case "weak_duplicate": {
        summary.weakDuplicates += 1;
        summary.ambiguous += 1;
        items.push({
          itemId: `external:${incomingContact.id}:weak`,
          contactId: match.local.id,
          kind: "external_weak_duplicate",
          requiresDecision: true,
        });
        break;
      }
      case "identity_mismatch": {
        summary.identityMismatches += 1;
        summary.ambiguous += 1;
        items.push({
          itemId: `external:${incomingContact.id}:mismatch`,
          contactId: match.local.id,
          kind: "external_identity_mismatch",
          requiresDecision: true,
        });
        break;
      }
      case "locally_deleted": {
        summary.locallyDeleted += 1;
        summary.ambiguous += 1;
        items.push({
          itemId: `external:${incomingContact.id}:deleted`,
          contactId: match.tombstone.contactId,
          kind: "external_locally_deleted",
          requiresDecision: true,
        });
        break;
      }
      case "broken_merged_lineage": {
        blockingIssues.push({
          code: "unresolved_merged_lineage",
          contactId: match.tombstone.contactId,
          message: `Contact ${match.tombstone.contactId} was merged into a contact that no longer exists.`,
        });
        break;
      }
      case "ambiguous_local_identity": {
        blockingIssues.push({
          code: "ambiguous_local_identity",
          contactId: incomingContact.id,
          message: match.reason,
        });
        break;
      }
    }
  }

  summary.pendingIdentityConflictsAfterImport = countPredictedConflicts(predictedActiveContacts, incoming.exportedAt);

  return { mode: "external_import", backup: backupSummary(incoming), summary, items, blockingIssues };
}

/**
 * Restore is snapshot replacement (Phase 3.6 §7): the backup wins as a
 * whole. This deliberately runs NO `updatedAt`/`identityUpdatedAt`/
 * `deletedAt` comparison and produces NO review items - the user already
 * made the only decision there is by choosing this restore point, and
 * re-introducing per-record decisions would just turn Restore back into
 * Merge (§8).
 *
 * The four counts answer "what will change" (§9), in the terms the user
 * actually experiences: a contact the backup has and the current Directory
 * does not - whether it never existed here or was deleted after the backup
 * was taken - is restored; a contact that exists on both sides with
 * different data reverts to the backup's version; a contact the backup does
 * not have as an active record is removed, which covers both data added
 * after the backup and a record the backup itself had already deleted.
 */
export function analyzeRestore(local: DirectorySnapshot, incoming: BackupSnapshotV2): ImportPreflight {
  const incomingContacts = new Map(incoming.contacts.map((contact) => [contact.id, contact]));
  const incomingTombstones = new Map(incoming.tombstones.map((tombstone) => [tombstone.contactId, tombstone]));
  const summary = emptySummary();

  const allIds = new Set<string>([
    ...local.contacts.keys(),
    ...local.tombstones.keys(),
    ...incomingContacts.keys(),
    ...incomingTombstones.keys(),
  ]);

  for (const id of allIds) {
    const localActive = local.contacts.get(id);
    const localTombstone = local.tombstones.get(id);
    const backupActive = incomingContacts.get(id);
    const backupTombstone = incomingTombstones.get(id);

    if (backupActive) {
      if (!localActive) summary.create += 1;
      else if (!contactsEqual(localActive, backupActive)) summary.update += 1;
      else summary.unchanged += 1;
      continue;
    }

    if (backupTombstone) {
      if (localActive) summary.delete += 1;
      else if (!localTombstone) summary.create += 1;
      else if (!tombstonesEqual(localTombstone, backupTombstone)) summary.update += 1;
      else summary.unchanged += 1;
      continue;
    }

    // Present locally, absent from the backup entirely - added after the
    // backup was taken, so restoring removes it.
    summary.delete += 1;
  }

  summary.pendingIdentityConflictsAfterImport = countPredictedConflicts(incomingContacts, incoming.exportedAt);

  return { mode: "restore", backup: backupSummary(incoming), summary, items: [], blockingIssues: [] };
}
