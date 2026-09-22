import type { ThreadContact } from "../domain/contact";
import type { ContactTombstone } from "../domain/tombstone";
import type { ImportBlockingIssue, SelfMergeReviewIssue } from "./importTypes";
import type {
  SelfMergeRecordResolution,
  SelfMergeRecordSide,
  SelfMergeResolution,
} from "./importTypes";
import type { ImportReviewDecision } from "./reviewDecisions";

function compareTimestamps(a: string, b: string): number {
  return Date.parse(a) - Date.parse(b);
}

function notesEqual(a: string | undefined, b: string | undefined): boolean {
  return (a ?? undefined) === (b ?? undefined);
}

// --- §31 Active vs Active: private data ------------------------------------

type PrivateDataSnapshot = Pick<ThreadContact, "nickname" | "note" | "updatedAt">;

/** Never actually "blocking" - private data alone has no fatal-contradiction case, unlike identity. */
export type PrivateDataMergeResolution =
  | { kind: "resolved"; value: PrivateDataSnapshot }
  | { kind: "review"; issue: SelfMergeReviewIssue };

export function mergeActivePrivateData(
  local: ThreadContact,
  incoming: ThreadContact,
): PrivateDataMergeResolution {
  const cmp = compareTimestamps(local.updatedAt, incoming.updatedAt);

  if (cmp === 0) {
    const sameData = local.nickname === incoming.nickname && notesEqual(local.note, incoming.note);
    if (sameData) {
      return { kind: "resolved", value: pickPrivateData(local) };
    }
    return {
      kind: "review",
      issue: { kind: "active_active_private_data", contactId: local.id },
    };
  }

  return { kind: "resolved", value: pickPrivateData(cmp > 0 ? local : incoming) };
}

function pickPrivateData(contact: ThreadContact): PrivateDataSnapshot {
  return { nickname: contact.nickname, note: contact.note, updatedAt: contact.updatedAt };
}

// --- §32 Active vs Active: identity data ------------------------------------

type IdentitySnapshot = Pick<ThreadContact, "username" | "threadsUserId" | "identityUpdatedAt">;

export function mergeActiveIdentitySnapshot(
  local: ThreadContact,
  incoming: ThreadContact,
): SelfMergeResolution<IdentitySnapshot> {
  const localId = local.threadsUserId;
  const incomingId = incoming.threadsUserId;

  if (localId !== undefined && incomingId !== undefined && localId !== incomingId) {
    return {
      kind: "blocking",
      issue: {
        code: "stable_identity_contradiction",
        contactId: local.id,
        message: `Contact ${local.id} has two different numeric Threads IDs across local and backup data.`,
      },
    };
  }

  if (localId !== undefined && incomingId === undefined) {
    return { kind: "resolved", value: pickIdentity(local) };
  }
  if (incomingId !== undefined && localId === undefined) {
    return { kind: "resolved", value: pickIdentity(incoming) };
  }

  // Both numeric IDs equal, or both absent.
  const cmp = compareTimestamps(local.identityUpdatedAt, incoming.identityUpdatedAt);
  if (cmp === 0) {
    if (local.username === incoming.username) {
      return { kind: "resolved", value: pickIdentity(local) };
    }
    return {
      kind: "review",
      issue: { kind: "active_active_identity_snapshot", contactId: local.id },
    };
  }

  return { kind: "resolved", value: pickIdentity(cmp > 0 ? local : incoming) };
}

function pickIdentity(contact: ThreadContact): IdentitySnapshot {
  return {
    username: contact.username,
    threadsUserId: contact.threadsUserId,
    identityUpdatedAt: contact.identityUpdatedAt,
  };
}

/**
 * Combines the private-data and identity-data verdicts into one contact.
 * `analyzeSelfMerge` calls the two dimension functions directly when it
 * needs to surface them as independent, separately-decidable review items;
 * this composed form is for callers (and Task 11/12's own tests) that just
 * want "the merged contact, or why not".
 */
export function mergeActiveContactVersions(
  local: ThreadContact,
  incoming: ThreadContact,
): SelfMergeResolution<ThreadContact> {
  const identity = mergeActiveIdentitySnapshot(local, incoming);
  if (identity.kind === "blocking") return identity;

  const privateData = mergeActivePrivateData(local, incoming);
  if (identity.kind === "review") return identity;
  if (privateData.kind !== "resolved") return privateData;

  const contact: ThreadContact = {
    id: local.id,
    createdAt: local.createdAt,
    username: identity.value.username,
    identityUpdatedAt: identity.value.identityUpdatedAt,
    nickname: privateData.value.nickname,
    updatedAt: privateData.value.updatedAt,
  };
  if (identity.value.threadsUserId !== undefined) contact.threadsUserId = identity.value.threadsUserId;
  if (privateData.value.note !== undefined) contact.note = privateData.value.note;

  return { kind: "resolved", value: contact };
}

/**
 * Identity and private data are independent dimensions (Phase 3 §31/§32):
 * the same contact can simultaneously need a private-data review AND an
 * identity-snapshot review. `mergeActiveContactVersions` above collapses
 * that into a single review (identity takes priority) for callers that just
 * want "one verdict"; `analyzeSelfMerge`/`buildSelfMergeCandidate` use this
 * instead so neither ambiguity is ever silently dropped in favor of the
 * other.
 */
export interface ActiveActiveAnalysis {
  blockingIssue?: ImportBlockingIssue;
  reviewIssues: SelfMergeReviewIssue[];
  resolvedContact?: ThreadContact;
}

export function analyzeActiveActivePair(local: ThreadContact, incoming: ThreadContact): ActiveActiveAnalysis {
  const identity = mergeActiveIdentitySnapshot(local, incoming);
  if (identity.kind === "blocking") {
    return { blockingIssue: identity.issue, reviewIssues: [] };
  }

  const privateData = mergeActivePrivateData(local, incoming);

  if (identity.kind === "review" || privateData.kind === "review") {
    const reviewIssues: SelfMergeReviewIssue[] = [];
    if (identity.kind === "review") reviewIssues.push(identity.issue);
    if (privateData.kind === "review") reviewIssues.push(privateData.issue);
    return { reviewIssues };
  }

  const contact: ThreadContact = {
    id: local.id,
    createdAt: local.createdAt,
    username: identity.value.username,
    identityUpdatedAt: identity.value.identityUpdatedAt,
    nickname: privateData.value.nickname,
    updatedAt: privateData.value.updatedAt,
  };
  if (identity.value.threadsUserId !== undefined) contact.threadsUserId = identity.value.threadsUserId;
  if (privateData.value.note !== undefined) contact.note = privateData.value.note;

  return { reviewIssues: [], resolvedContact: contact };
}

export interface ActiveActiveBuildResult {
  contact?: ThreadContact;
  blockingIssue?: ImportBlockingIssue;
  missingItemIds: string[];
}

/** Applies each dimension's decision independently, never letting one dimension's decision stand in for the other. */
export function buildActiveActivePair(
  local: ThreadContact,
  incoming: ThreadContact,
  decisions: ReadonlyMap<string, ImportReviewDecision>,
  operationNow: string,
): ActiveActiveBuildResult {
  const identity = mergeActiveIdentitySnapshot(local, incoming);
  if (identity.kind === "blocking") {
    return { blockingIssue: identity.issue, missingItemIds: [] };
  }

  const privateData = mergeActivePrivateData(local, incoming);
  const missingItemIds: string[] = [];

  let identitySnapshot: IdentitySnapshot;
  if (identity.kind === "resolved") {
    identitySnapshot = identity.value;
  } else {
    const itemId = `contact:${identity.issue.contactId}:identity`;
    const decision = decisions.get(itemId);
    if (decision && decision.kind === "choose_identity_snapshot") {
      const source = decision.source === "local" ? local : incoming;
      identitySnapshot = { username: source.username, threadsUserId: source.threadsUserId, identityUpdatedAt: operationNow };
    } else {
      missingItemIds.push(itemId);
      identitySnapshot = pickIdentity(local);
    }
  }

  let privateSnapshot: PrivateDataSnapshot;
  if (privateData.kind === "resolved") {
    privateSnapshot = privateData.value;
  } else {
    const itemId = `contact:${privateData.issue.contactId}:private`;
    const decision = decisions.get(itemId);
    if (decision && decision.kind === "keep_local") {
      privateSnapshot = { nickname: local.nickname, note: local.note, updatedAt: operationNow };
    } else if (decision && decision.kind === "use_incoming_private_data") {
      privateSnapshot = { nickname: incoming.nickname, note: incoming.note, updatedAt: operationNow };
    } else if (decision && decision.kind === "custom_private_data") {
      privateSnapshot = { nickname: decision.nickname, note: decision.note, updatedAt: operationNow };
    } else {
      missingItemIds.push(itemId);
      privateSnapshot = pickPrivateData(local);
    }
  }

  if (missingItemIds.length > 0) {
    return { missingItemIds };
  }

  const contact: ThreadContact = {
    id: local.id,
    createdAt: local.createdAt,
    username: identitySnapshot.username,
    identityUpdatedAt: identitySnapshot.identityUpdatedAt,
    nickname: privateSnapshot.nickname,
    updatedAt: privateSnapshot.updatedAt,
  };
  if (identitySnapshot.threadsUserId !== undefined) contact.threadsUserId = identitySnapshot.threadsUserId;
  if (privateSnapshot.note !== undefined) contact.note = privateSnapshot.note;

  return { contact, missingItemIds: [] };
}

// --- §33/§34 Active vs Tombstone ---------------------------------------------

function mergeActiveTombstone(active: ThreadContact, tombstone: ContactTombstone): SelfMergeRecordResolution {
  if (tombstone.reason === "merged") {
    // A duplicate contact cannot be resurrected by an older backup, regardless of timestamps.
    return { kind: "resolved", result: { type: "tombstone", tombstone } };
  }

  if (
    active.threadsUserId !== undefined &&
    tombstone.threadsUserId !== undefined &&
    active.threadsUserId !== tombstone.threadsUserId
  ) {
    return {
      kind: "blocking",
      issue: {
        code: "stable_identity_contradiction",
        contactId: active.id,
        message: `Contact ${active.id} has two different numeric Threads IDs across an active record and a tombstone.`,
      },
    };
  }

  const cmp = compareTimestamps(active.updatedAt, tombstone.deletedAt);
  if (cmp === 0) {
    return {
      kind: "review",
      issue: { kind: "active_tombstone_lifecycle", contactId: active.id },
    };
  }
  if (cmp > 0) {
    // The active record is a later resurrection than this deletion.
    return { kind: "resolved", result: { type: "active", contact: active } };
  }
  return { kind: "resolved", result: { type: "tombstone", tombstone } };
}

// --- §35/§36/§37 Tombstone vs Tombstone --------------------------------------

function mergeTombstoneTombstone(
  local: ContactTombstone,
  incoming: ContactTombstone,
): SelfMergeRecordResolution {
  if (local.reason === "merged" && incoming.reason === "merged") {
    if (local.mergedIntoContactId !== incoming.mergedIntoContactId) {
      return {
        kind: "blocking",
        issue: {
          code: "merged_lineage_conflict",
          contactId: local.contactId,
          message: `Contact ${local.contactId} was merged into two different contacts locally and in the backup.`,
        },
      };
    }
    const cmp = compareTimestamps(local.deletedAt, incoming.deletedAt);
    return { kind: "resolved", result: { type: "tombstone", tombstone: cmp >= 0 ? local : incoming } };
  }

  if (local.reason === "merged" || incoming.reason === "merged") {
    // merged > ordinary user_deleted lifecycle, unconditionally (§40).
    return {
      kind: "resolved",
      result: { type: "tombstone", tombstone: local.reason === "merged" ? local : incoming },
    };
  }

  if (
    local.threadsUserId !== undefined &&
    incoming.threadsUserId !== undefined &&
    local.threadsUserId !== incoming.threadsUserId
  ) {
    return {
      kind: "blocking",
      issue: {
        code: "stable_identity_contradiction",
        contactId: local.contactId,
        message: `Contact ${local.contactId} has two different numeric Threads IDs across local and backup tombstones.`,
      },
    };
  }

  const cmp = compareTimestamps(local.deletedAt, incoming.deletedAt);
  if (cmp === 0) {
    const sameData = local.username === incoming.username && local.threadsUserId === incoming.threadsUserId;
    if (sameData) {
      return { kind: "resolved", result: { type: "tombstone", tombstone: local } };
    }
    return {
      kind: "review",
      issue: { kind: "tombstone_tombstone_lifecycle", contactId: local.contactId },
    };
  }

  return { kind: "resolved", result: { type: "tombstone", tombstone: cmp > 0 ? local : incoming } };
}

/** Dispatches a same-contactId local/incoming pair to the right §31-§37 rule. */
export function mergeContactRecord(
  local: SelfMergeRecordSide,
  incoming: SelfMergeRecordSide,
): SelfMergeRecordResolution {
  if (local.type === "active") {
    if (incoming.type === "active") {
      const merged = mergeActiveContactVersions(local.contact, incoming.contact);
      if (merged.kind !== "resolved") return merged;
      return { kind: "resolved", result: { type: "active", contact: merged.value } };
    }
    return mergeActiveTombstone(local.contact, incoming.tombstone);
  }

  if (incoming.type === "tombstone") {
    return mergeTombstoneTombstone(local.tombstone, incoming.tombstone);
  }
  return mergeActiveTombstone(incoming.contact, local.tombstone);
}
