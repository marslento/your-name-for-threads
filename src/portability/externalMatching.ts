import type { ThreadContact } from "../domain/contact";
import type { ContactTombstone } from "../domain/tombstone";
import type { DirectorySnapshot } from "../domain/directorySnapshot";
import { normalizeUsername } from "../domain/validation";
import type { ExternalMatch } from "./importTypes";

/**
 * Marks an index key that more than one local record maps to (Phase 3
 * review round 3, High #2) - e.g. two active contacts sharing a
 * `threadsUserId` under an unresolved Phase 2 identity conflict. A plain
 * `Map.set` would let the second insert silently win; every lookup must
 * instead surface the ambiguity so external matching never arbitrarily
 * picks one of several equally-plausible local targets.
 */
const AMBIGUOUS = Symbol("ambiguous-index-entry");
type IndexEntry<T> = T | typeof AMBIGUOUS;

function indexBy<T>(map: Map<string, IndexEntry<T>>, key: string, value: T): void {
  map.set(key, map.has(key) ? AMBIGUOUS : value);
}

export interface ExternalMatchIndexes {
  localActiveById: Map<string, ThreadContact>;
  localActiveByThreadsUserId: Map<string, IndexEntry<ThreadContact>>;
  localActiveByNormalizedUsername: Map<string, IndexEntry<ThreadContact>>;
  localUserDeletedTombstoneByThreadsUserId: Map<string, IndexEntry<ContactTombstone>>;
  localMergedTombstoneByThreadsUserId: Map<string, IndexEntry<ContactTombstone>>;
  localMergedTombstoneByNormalizedUsername: Map<string, IndexEntry<ContactTombstone>>;
}

function safeNormalizeUsername(value: string): string | null {
  try {
    return normalizeUsername(value);
  } catch {
    return null;
  }
}

/** Indexed lookups (Phase 3 §65) so classification stays O(1) per incoming contact instead of an O(n^2) full-list scan. */
export function buildExternalMatchIndexes(local: DirectorySnapshot): ExternalMatchIndexes {
  const localActiveById = new Map<string, ThreadContact>();
  const localActiveByThreadsUserId = new Map<string, IndexEntry<ThreadContact>>();
  const localActiveByNormalizedUsername = new Map<string, IndexEntry<ThreadContact>>();
  for (const contact of local.contacts.values()) {
    localActiveById.set(contact.id, contact);
    if (contact.threadsUserId !== undefined) {
      indexBy(localActiveByThreadsUserId, contact.threadsUserId, contact);
    }
    const normalized = safeNormalizeUsername(contact.username);
    if (normalized !== null) indexBy(localActiveByNormalizedUsername, normalized, contact);
  }

  const localUserDeletedTombstoneByThreadsUserId = new Map<string, IndexEntry<ContactTombstone>>();
  const localMergedTombstoneByThreadsUserId = new Map<string, IndexEntry<ContactTombstone>>();
  const localMergedTombstoneByNormalizedUsername = new Map<string, IndexEntry<ContactTombstone>>();
  for (const tombstone of local.tombstones.values()) {
    if (tombstone.reason === "user_deleted" && tombstone.threadsUserId !== undefined) {
      indexBy(localUserDeletedTombstoneByThreadsUserId, tombstone.threadsUserId, tombstone);
    }
    if (tombstone.reason === "merged") {
      if (tombstone.threadsUserId !== undefined) {
        indexBy(localMergedTombstoneByThreadsUserId, tombstone.threadsUserId, tombstone);
      }
      const normalized = safeNormalizeUsername(tombstone.username);
      if (normalized !== null) indexBy(localMergedTombstoneByNormalizedUsername, normalized, tombstone);
    }
  }

  return {
    localActiveById,
    localActiveByThreadsUserId,
    localActiveByNormalizedUsername,
    localUserDeletedTombstoneByThreadsUserId,
    localMergedTombstoneByThreadsUserId,
    localMergedTombstoneByNormalizedUsername,
  };
}

/**
 * A merged tombstone can never be resurrected as its own contact (Phase 3
 * §27) - matching it redirects to its canonical active contact and applies
 * the ordinary Stable/Weak/Mismatch rules against *that* contact instead.
 * If the canonical contact cannot be resolved, this is a broken lineage
 * External Import must not repair or guess through.
 */
function classifyAgainstMergedCanonical(
  incoming: ThreadContact,
  mergedTombstone: ContactTombstone,
  indexes: ExternalMatchIndexes,
): ExternalMatch {
  const canonical = mergedTombstone.mergedIntoContactId
    ? indexes.localActiveById.get(mergedTombstone.mergedIntoContactId)
    : undefined;
  if (!canonical) {
    return { kind: "broken_merged_lineage", incoming, tombstone: mergedTombstone };
  }

  const bothStable = incoming.threadsUserId !== undefined && canonical.threadsUserId !== undefined;
  if (bothStable && incoming.threadsUserId !== canonical.threadsUserId) {
    return { kind: "identity_mismatch", incoming, local: canonical };
  }
  if (incoming.threadsUserId !== undefined && incoming.threadsUserId === canonical.threadsUserId) {
    return { kind: "stable_duplicate", incoming, local: canonical };
  }
  return { kind: "weak_duplicate", incoming, local: canonical };
}

/** Priority order from Phase 3 §21. Incoming `contact.id` is never used as an identity key. */
export function classifyExternalContact(
  incoming: ThreadContact,
  indexes: ExternalMatchIndexes,
): ExternalMatch {
  if (incoming.threadsUserId !== undefined) {
    const stable = indexes.localActiveByThreadsUserId.get(incoming.threadsUserId);
    if (stable === AMBIGUOUS) {
      return {
        kind: "ambiguous_local_identity",
        incoming,
        reason: `Threads ID ${incoming.threadsUserId} matches more than one local active contact.`,
      };
    }
    if (stable) return { kind: "stable_duplicate", incoming, local: stable };

    const tombstone = indexes.localUserDeletedTombstoneByThreadsUserId.get(incoming.threadsUserId);
    if (tombstone === AMBIGUOUS) {
      return {
        kind: "ambiguous_local_identity",
        incoming,
        reason: `Threads ID ${incoming.threadsUserId} matches more than one local deletion record.`,
      };
    }
    if (tombstone) return { kind: "locally_deleted", incoming, tombstone };

    const merged = indexes.localMergedTombstoneByThreadsUserId.get(incoming.threadsUserId);
    if (merged === AMBIGUOUS) {
      return {
        kind: "ambiguous_local_identity",
        incoming,
        reason: `Threads ID ${incoming.threadsUserId} matches more than one local merge record.`,
      };
    }
    if (merged) return classifyAgainstMergedCanonical(incoming, merged, indexes);
  }

  const normalizedUsername = safeNormalizeUsername(incoming.username);

  if (normalizedUsername !== null) {
    const mergedByUsername = indexes.localMergedTombstoneByNormalizedUsername.get(normalizedUsername);
    if (mergedByUsername === AMBIGUOUS) {
      return {
        kind: "ambiguous_local_identity",
        incoming,
        reason: `Username "${incoming.username}" matches more than one local merge record.`,
      };
    }
    if (mergedByUsername) return classifyAgainstMergedCanonical(incoming, mergedByUsername, indexes);
  }

  const byUsername =
    normalizedUsername === null ? undefined : indexes.localActiveByNormalizedUsername.get(normalizedUsername);
  if (byUsername === AMBIGUOUS) {
    return {
      kind: "ambiguous_local_identity",
      incoming,
      reason: `Username "${incoming.username}" matches more than one local active contact.`,
    };
  }
  if (byUsername) {
    const bothStable = incoming.threadsUserId !== undefined && byUsername.threadsUserId !== undefined;
    if (bothStable && incoming.threadsUserId !== byUsername.threadsUserId) {
      return { kind: "identity_mismatch", incoming, local: byUsername };
    }
    return { kind: "weak_duplicate", incoming, local: byUsername };
  }

  return { kind: "new_contact", incoming };
}

/**
 * Local record ids that more than one entry in `targets` names (Phase 3
 * review round 3, High #2 / round 4 follow-up). Takes plain resolved
 * targets rather than `ExternalMatch[]` because "what a match would
 * actually write to" depends on the applicable strategy/decision, not the
 * match kind alone - a Stable Duplicate under `keep_local` writes nothing,
 * so it must never even be counted here. Callers compute each entry's
 * target with whatever resolution rule fits their stage (see
 * `analyzeExternalImport`'s strategy-only preflight check and
 * `buildExternalImportCandidate`'s fully decision-aware one) and pass a
 * `null` for "this one writes nothing, ignore it".
 */
export function findDuplicateTargets(targets: readonly (string | null)[]): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const target of targets) {
    if (target === null) continue;
    counts.set(target, (counts.get(target) ?? 0) + 1);
  }

  const duplicates = new Set<string>();
  for (const [target, count] of counts) {
    if (count > 1) duplicates.add(target);
  }
  return duplicates;
}
