import type { ThreadContact } from "../domain/contact";
import type { ContactTombstone } from "../domain/tombstone";
import type { DirectorySnapshot } from "../domain/directorySnapshot";
import type { BackupSnapshotV2 } from "./backupTypes";
import { buildExternalMatchIndexes, classifyExternalContact, findDuplicateTargets } from "./externalMatching";
import type {
  ExternalDuplicateStrategy,
  ExternalMatch,
  ImportBlockingIssue,
  ImportPreflight,
  SelfMergeRecordSide,
  SelfMergeReviewIssue,
} from "./importTypes";
import type { ImportSession } from "./importSession";
import type { ImportReviewDecision } from "./reviewDecisions";
import { buildActiveActivePair, mergeContactRecord } from "./selfMerge";

export type CandidateBuildIssue =
  | { type: "blocking"; issue: ImportBlockingIssue }
  | { type: "missing_decision"; itemId: string };

export type CandidateBuildResult =
  | { ok: true; candidate: DirectorySnapshot }
  | { ok: false; issues: CandidateBuildIssue[] };

function newContactFromIncoming(incoming: ThreadContact, id: string, operationNow: string): ThreadContact {
  const contact: ThreadContact = {
    id,
    username: incoming.username,
    nickname: incoming.nickname,
    createdAt: operationNow,
    updatedAt: operationNow,
    identityUpdatedAt: operationNow,
  };
  if (incoming.threadsUserId !== undefined) contact.threadsUserId = incoming.threadsUserId;
  if (incoming.note !== undefined) contact.note = incoming.note;
  return contact;
}

function applyIncomingPrivateData(local: ThreadContact, incoming: ThreadContact, operationNow: string): ThreadContact {
  const updated: ThreadContact = { ...local, nickname: incoming.nickname, updatedAt: operationNow };
  if (incoming.note !== undefined) updated.note = incoming.note;
  else delete updated.note;
  return updated;
}

function applyCustomPrivateData(
  local: ThreadContact,
  decision: Extract<ImportReviewDecision, { kind: "custom_private_data" }>,
  operationNow: string,
): ThreadContact {
  const updated: ThreadContact = { ...local, nickname: decision.nickname, updatedAt: operationNow };
  if (decision.note !== undefined) updated.note = decision.note;
  else delete updated.note;
  return updated;
}

// --- External Import ---------------------------------------------------

function processExternalMatch(
  match: ExternalMatch,
  strategy: ExternalDuplicateStrategy,
  decisions: ReadonlyMap<string, ImportReviewDecision>,
  candidateContacts: Map<string, ThreadContact>,
  candidateTombstones: Map<string, ContactTombstone>,
  operationNow: string,
  createUuid: () => string,
  issues: CandidateBuildIssue[],
): void {
  if (match.kind === "new_contact") {
    const id = createUuid();
    candidateContacts.set(id, newContactFromIncoming(match.incoming, id, operationNow));
    return;
  }

  if (match.kind === "stable_duplicate") {
    const itemId = `external:${match.incoming.id}:stable`;
    if (strategy === "keep_local") return;
    if (strategy === "use_incoming") {
      candidateContacts.set(match.local.id, applyIncomingPrivateData(match.local, match.incoming, operationNow));
      return;
    }
    const decision = decisions.get(itemId);
    if (!decision) { issues.push({ type: "missing_decision", itemId }); return; }
    if (decision.kind === "keep_local") return;
    if (decision.kind === "use_incoming_private_data") {
      candidateContacts.set(match.local.id, applyIncomingPrivateData(match.local, match.incoming, operationNow));
      return;
    }
    if (decision.kind === "custom_private_data") {
      candidateContacts.set(match.local.id, applyCustomPrivateData(match.local, decision, operationNow));
      return;
    }
    issues.push({ type: "missing_decision", itemId });
    return;
  }

  if (match.kind === "weak_duplicate") {
    const itemId = `external:${match.incoming.id}:weak`;
    const decision = decisions.get(itemId);
    if (!decision) { issues.push({ type: "missing_decision", itemId }); return; }
    if (decision.kind === "import_as_new") {
      const id = createUuid();
      candidateContacts.set(id, newContactFromIncoming(match.incoming, id, operationNow));
      return;
    }
    if (decision.kind === "confirm_weak_identity") {
      const updated: ThreadContact = { ...match.local, nickname: decision.nickname, updatedAt: operationNow };
      if (decision.note !== undefined) updated.note = decision.note;
      else delete updated.note;
      // The only External Import path where identity information may upgrade a weak local identity (Phase 3 §24) - requires this explicit human confirmation.
      if (
        decision.adoptIncomingThreadsUserId &&
        match.local.threadsUserId === undefined &&
        match.incoming.threadsUserId !== undefined
      ) {
        updated.threadsUserId = match.incoming.threadsUserId;
        updated.identityUpdatedAt = operationNow;
      }
      candidateContacts.set(match.local.id, updated);
      return;
    }
    issues.push({ type: "missing_decision", itemId });
    return;
  }

  if (match.kind === "identity_mismatch") {
    const itemId = `external:${match.incoming.id}:mismatch`;
    const decision = decisions.get(itemId);
    if (!decision) { issues.push({ type: "missing_decision", itemId }); return; }
    if (decision.kind === "import_as_new") {
      const id = createUuid();
      candidateContacts.set(id, newContactFromIncoming(match.incoming, id, operationNow));
      return;
    }
    if (decision.kind !== "keep_local") issues.push({ type: "missing_decision", itemId });
    return;
  }

  if (match.kind === "broken_merged_lineage") {
    issues.push({
      type: "blocking",
      issue: {
        code: "unresolved_merged_lineage",
        contactId: match.tombstone.contactId,
        message: `Contact ${match.tombstone.contactId} was merged into a contact that no longer exists.`,
      },
    });
    return;
  }

  if (match.kind === "ambiguous_local_identity") {
    issues.push({
      type: "blocking",
      issue: { code: "ambiguous_local_identity", contactId: match.incoming.id, message: match.reason },
    });
    return;
  }

  // locally_deleted
  const itemId = `external:${match.incoming.id}:deleted`;
  const decision = decisions.get(itemId);
  if (!decision) { issues.push({ type: "missing_decision", itemId }); return; }
  if (decision.kind === "resurrect") {
    candidateTombstones.delete(match.tombstone.contactId);
    const resurrected: ThreadContact = {
      id: match.tombstone.contactId,
      username: match.incoming.username,
      nickname: match.incoming.nickname,
      createdAt: match.tombstone.createdAt,
      updatedAt: operationNow,
      identityUpdatedAt: operationNow,
    };
    if (match.incoming.threadsUserId !== undefined) resurrected.threadsUserId = match.incoming.threadsUserId;
    if (match.incoming.note !== undefined) resurrected.note = match.incoming.note;
    candidateContacts.set(resurrected.id, resurrected);
    return;
  }
  if (decision.kind !== "keep_deleted") issues.push({ type: "missing_decision", itemId });
}

/**
 * What a match will actually write to an existing local record, given the
 * strategy and whatever decision has been made so far - `null` when this
 * match writes nothing to an existing record (no decision yet, or the
 * decision itself doesn't touch one: `keep_local`, `keep_deleted`,
 * `import_as_new`). This mirrors `processExternalMatch`'s own branching but
 * only asks "what would it touch", never performs the mutation - used
 * purely to detect two incoming records about to touch the same local
 * record (Phase 3 review round 3, High #2 -> round 4 follow-up: the
 * original version treated every Stable/Weak Duplicate and Locally Deleted
 * match as a target regardless of the eventual decision, so even entirely
 * safe combinations like two Stable Duplicates both resolving to
 * `keep_local` were wrongly blocked).
 */
function resolveExternalMatchWriteTarget(
  match: ExternalMatch,
  strategy: ExternalDuplicateStrategy,
  decisions: ReadonlyMap<string, ImportReviewDecision>,
): string | null {
  if (match.kind === "stable_duplicate") {
    if (strategy === "keep_local") return null;
    if (strategy === "use_incoming") return match.local.id;
    const decision = decisions.get(`external:${match.incoming.id}:stable`);
    if (decision?.kind === "use_incoming_private_data" || decision?.kind === "custom_private_data") {
      return match.local.id;
    }
    return null;
  }

  if (match.kind === "weak_duplicate") {
    const decision = decisions.get(`external:${match.incoming.id}:weak`);
    return decision?.kind === "confirm_weak_identity" ? match.local.id : null;
  }

  if (match.kind === "locally_deleted") {
    const decision = decisions.get(`external:${match.incoming.id}:deleted`);
    return decision?.kind === "resurrect" ? match.tombstone.contactId : null;
  }

  return null;
}

export function buildExternalImportCandidate(input: {
  latestLocal: DirectorySnapshot;
  incoming: BackupSnapshotV2;
  preflight: ImportPreflight;
  strategy: ExternalDuplicateStrategy;
  decisions: ReadonlyMap<string, ImportReviewDecision>;
  operationNow: string;
  createUuid: () => string;
}): CandidateBuildResult {
  const candidateContacts = new Map(input.latestLocal.contacts);
  const candidateTombstones = new Map(input.latestLocal.tombstones);
  const indexes = buildExternalMatchIndexes(input.latestLocal);
  const issues: CandidateBuildIssue[] = [];

  const matches = input.incoming.contacts.map((incomingContact) => classifyExternalContact(incomingContact, indexes));
  const resolvedTargets = matches.map((match) => resolveExternalMatchWriteTarget(match, input.strategy, input.decisions));
  const duplicateTargets = findDuplicateTargets(resolvedTargets);

  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    const writeTarget = resolvedTargets[i];
    if (writeTarget !== null && duplicateTargets.has(writeTarget)) {
      // More than one incoming record's ACTUAL resolved decision would
      // apply private data to (or resurrect) the same local contact - the
      // exact "last array entry silently wins" bug this guard closes.
      // Computed from the full pre-pass above, so it can never depend on
      // which incoming record happens to come first.
      issues.push({
        type: "blocking",
        issue: {
          code: "duplicate_import_target",
          contactId: writeTarget,
          message: `More than one contact in this backup would write to local contact ${writeTarget} - resolve the duplicate in the backup before importing.`,
        },
      });
      continue;
    }

    processExternalMatch(
      match,
      input.strategy,
      input.decisions,
      candidateContacts,
      candidateTombstones,
      input.operationNow,
      input.createUuid,
      issues,
    );
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    candidate: { directoryId: input.latestLocal.directoryId, contacts: candidateContacts, tombstones: candidateTombstones },
  };
}

// --- Self Merge ----------------------------------------------------------

function sideOf(
  id: string,
  contacts: ReadonlyMap<string, ThreadContact>,
  tombstones: ReadonlyMap<string, ContactTombstone>,
): SelfMergeRecordSide | undefined {
  const contact = contacts.get(id);
  if (contact) return { type: "active", contact };
  const tombstone = tombstones.get(id);
  if (tombstone) return { type: "tombstone", tombstone };
  return undefined;
}

export function selfMergeReviewItemId(issue: SelfMergeReviewIssue): string {
  const dimension =
    issue.kind === "active_active_private_data"
      ? "private"
      : issue.kind === "active_active_identity_snapshot"
        ? "identity"
        : "lifecycle";
  return `contact:${issue.contactId}:${dimension}`;
}

function applySelfMergeReviewDecision(
  issue: SelfMergeReviewIssue,
  decision: ImportReviewDecision,
  localSide: SelfMergeRecordSide,
  incomingSide: SelfMergeRecordSide,
  operationNow: string,
): SelfMergeRecordSide | null {
  if (issue.kind === "active_active_private_data") {
    if (localSide.type !== "active" || incomingSide.type !== "active") return null;
    if (decision.kind === "keep_local") {
      return { type: "active", contact: { ...localSide.contact, updatedAt: operationNow } };
    }
    if (decision.kind === "use_incoming_private_data") {
      return { type: "active", contact: applyIncomingPrivateData(localSide.contact, incomingSide.contact, operationNow) };
    }
    if (decision.kind === "custom_private_data") {
      return { type: "active", contact: applyCustomPrivateData(localSide.contact, decision, operationNow) };
    }
    return null;
  }

  if (issue.kind === "active_active_identity_snapshot") {
    if (localSide.type !== "active" || incomingSide.type !== "active" || decision.kind !== "choose_identity_snapshot") {
      return null;
    }
    const source = decision.source === "local" ? localSide.contact : incomingSide.contact;
    const updated: ThreadContact = { ...localSide.contact, username: source.username, identityUpdatedAt: operationNow };
    if (source.threadsUserId !== undefined) updated.threadsUserId = source.threadsUserId;
    else delete updated.threadsUserId;
    return { type: "active", contact: updated };
  }

  if (issue.kind === "active_tombstone_lifecycle") {
    const active = localSide.type === "active" ? localSide : incomingSide.type === "active" ? incomingSide : null;
    const tombstoned = localSide.type === "tombstone" ? localSide : incomingSide.type === "tombstone" ? incomingSide : null;
    if (decision.kind === "keep_active" && active) {
      return { type: "active", contact: { ...active.contact, updatedAt: operationNow } };
    }
    if (decision.kind === "keep_tombstone" && tombstoned) {
      return { type: "tombstone", tombstone: { ...tombstoned.tombstone, deletedAt: operationNow } };
    }
    return null;
  }

  // tombstone_tombstone_lifecycle: no active side exists - the choice is which side's tombstone snapshot to keep.
  if (localSide.type !== "tombstone" || incomingSide.type !== "tombstone" || decision.kind !== "choose_identity_snapshot") {
    return null;
  }
  const source = decision.source === "local" ? localSide.tombstone : incomingSide.tombstone;
  return { type: "tombstone", tombstone: { ...source, deletedAt: operationNow } };
}

export function buildSelfMergeCandidate(input: {
  latestLocal: DirectorySnapshot;
  incoming: BackupSnapshotV2;
  preflight: ImportPreflight;
  decisions: ReadonlyMap<string, ImportReviewDecision>;
  operationNow: string;
}): CandidateBuildResult {
  const incomingContactsById = new Map(input.incoming.contacts.map((contact) => [contact.id, contact]));
  const incomingTombstonesById = new Map(input.incoming.tombstones.map((tombstone) => [tombstone.contactId, tombstone]));
  const allIds = new Set<string>([
    ...input.latestLocal.contacts.keys(),
    ...input.latestLocal.tombstones.keys(),
    ...incomingContactsById.keys(),
    ...incomingTombstonesById.keys(),
  ]);

  const candidateContacts = new Map<string, ThreadContact>();
  const candidateTombstones = new Map<string, ContactTombstone>();
  const issues: CandidateBuildIssue[] = [];

  function place(side: SelfMergeRecordSide, id: string): void {
    if (side.type === "active") candidateContacts.set(id, side.contact);
    else candidateTombstones.set(id, side.tombstone);
  }

  for (const id of allIds) {
    const localSide = sideOf(id, input.latestLocal.contacts, input.latestLocal.tombstones);
    const incomingSide = sideOf(id, incomingContactsById, incomingTombstonesById);

    if (!incomingSide) {
      if (localSide) place(localSide, id);
      continue;
    }
    if (!localSide) {
      place(incomingSide, id);
      continue;
    }

    if (localSide.type === "active" && incomingSide.type === "active") {
      const built = buildActiveActivePair(localSide.contact, incomingSide.contact, input.decisions, input.operationNow);
      if (built.blockingIssue) {
        issues.push({ type: "blocking", issue: built.blockingIssue });
        continue;
      }
      if (built.missingItemIds.length > 0) {
        for (const itemId of built.missingItemIds) issues.push({ type: "missing_decision", itemId });
        continue;
      }
      candidateContacts.set(id, built.contact!);
      continue;
    }

    const resolution = mergeContactRecord(localSide, incomingSide);
    if (resolution.kind === "blocking") {
      issues.push({ type: "blocking", issue: resolution.issue });
      continue;
    }
    if (resolution.kind === "resolved") {
      place(resolution.result, id);
      continue;
    }

    const itemId = selfMergeReviewItemId(resolution.issue);
    const decision = input.decisions.get(itemId);
    if (!decision) {
      issues.push({ type: "missing_decision", itemId });
      continue;
    }

    const applied = applySelfMergeReviewDecision(resolution.issue, decision, localSide, incomingSide, input.operationNow);
    if (!applied) {
      issues.push({ type: "missing_decision", itemId });
      continue;
    }
    place(applied, id);
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    candidate: { directoryId: input.latestLocal.directoryId, contacts: candidateContacts, tombstones: candidateTombstones },
  };
}

// --- Restore ---------------------------------------------------------------

/**
 * Snapshot replacement (Phase 3.6 §7): the candidate IS the backup. Incoming
 * UUIDs, lifecycle timestamps and tombstones are preserved verbatim, and
 * whatever the local Directory currently holds is simply not carried over -
 * which is what makes Restore resurrect a post-backup deletion and drop a
 * post-backup addition, where Merge does neither. Cannot fail - the backup
 * is already validated, and there is nothing local to reconcile against.
 *
 * Same for "adoptable_lineage" (§22, an empty local Directory adopting the
 * backup's lineage) and for "same_lineage" (§6, where `incoming.directoryId`
 * is already the local one), so there is only ever one restore path.
 */
export function buildRestoreCandidate(incoming: BackupSnapshotV2): DirectorySnapshot {
  return {
    directoryId: incoming.directoryId,
    contacts: new Map(incoming.contacts.map((contact) => [contact.id, contact])),
    tombstones: new Map(incoming.tombstones.map((tombstone) => [tombstone.contactId, tombstone])),
  };
}

/**
 * One dispatch point for "build the candidate for this session's mode",
 * shared by `executeImport` (real `latestLocal`/clock/uuid, followed by a
 * commit) and the final-confirmation preview (session's own baseline and
 * placeholder clock/uuid, never committed) - so both can only ever show/act
 * on the same candidate-building logic, never two implementations that can
 * drift apart.
 */
export function buildSessionCandidate(
  session: ImportSession,
  latestLocal: DirectorySnapshot,
  operationNow: string,
  createUuid: () => string,
): CandidateBuildResult {
  if (session.mode === "restore") {
    return { ok: true, candidate: buildRestoreCandidate(session.source) };
  }

  if (session.mode === "self_merge") {
    return buildSelfMergeCandidate({
      latestLocal,
      incoming: session.source,
      preflight: session.preflight,
      decisions: session.reviewDecisions,
      operationNow,
    });
  }

  return buildExternalImportCandidate({
    latestLocal,
    incoming: session.source,
    preflight: session.preflight,
    strategy: session.duplicateStrategy ?? "review_each",
    decisions: session.reviewDecisions,
    operationNow,
    createUuid,
  });
}
