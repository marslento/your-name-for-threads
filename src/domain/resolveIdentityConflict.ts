import type { ThreadContact } from "./contact";
import type { ContactTombstone } from "./tombstone";
import { assertValidTombstone } from "./tombstone";
import type { IdentityConflict } from "./conflict";
import { selectCanonicalContact } from "./conflictCanonical";
import { normalizeNickname, normalizeNote } from "./validation";

export interface ResolveConflictInput {
  conflictId: string;
  nickname: string;
  note: string;
  expectedSources: Array<{
    contactId: string;
    updatedAt: string;
    identityUpdatedAt: string;
  }>;
  now: string;
}

export type ResolveConflictResult =
  | { type: "resolved"; contact: ThreadContact }
  | { type: "stale" }
  | { type: "missing" };

/**
 * The storage slice this service reads and mutates in place. Mutating a
 * caller-owned draft (rather than returning a separate patch) mirrors how
 * `migrateV1ToV2` builds a complete result in memory before the one storage
 * write the caller performs afterward.
 */
export interface ResolveConflictStorage {
  contacts: Record<string, ThreadContact>;
  tombstones: Record<string, ContactTombstone>;
  identityIndex: Record<string, string>;
  identityConflicts: Record<string, IdentityConflict>;
}

/**
 * Re-reads the conflict and every source contact against `storage` (the
 * caller is expected to have just loaded it) before applying, so a merge
 * started against stale data is rejected instead of silently overwriting a
 * concurrent edit.
 */
export function resolveIdentityConflict(
  storage: ResolveConflictStorage,
  input: ResolveConflictInput,
): ResolveConflictResult {
  const conflict = storage.identityConflicts[input.conflictId];
  if (!conflict) return { type: "missing" };

  const sources: ThreadContact[] = [];
  for (const contactId of conflict.contactIds) {
    const source = storage.contacts[contactId];
    if (!source) return { type: "missing" };
    sources.push(source);
  }

  for (const source of sources) {
    const expected = input.expectedSources.find((s) => s.contactId === source.id);
    if (!expected) return { type: "missing" };
    if (
      expected.updatedAt !== source.updatedAt ||
      expected.identityUpdatedAt !== source.identityUpdatedAt
    ) {
      return { type: "stale" };
    }
  }

  const canonical = selectCanonicalContact(conflict, sources);
  if (!canonical) return { type: "missing" };
  const duplicates = sources.filter((source) => source.id !== canonical.id);

  const nickname = normalizeNickname(input.nickname);
  const note = normalizeNote(input.note);

  const updatedCanonical: ThreadContact = {
    ...canonical,
    nickname,
    updatedAt: input.now,
  };
  if (note) {
    updatedCanonical.note = note;
  } else {
    delete updatedCanonical.note;
  }
  storage.contacts[canonical.id] = updatedCanonical;

  for (const duplicate of duplicates) {
    delete storage.contacts[duplicate.id];

    const tombstone: ContactTombstone = {
      contactId: duplicate.id,
      username: duplicate.username,
      createdAt: duplicate.createdAt,
      deletedAt: input.now,
      reason: "merged",
      mergedIntoContactId: canonical.id,
      ...(duplicate.threadsUserId === undefined ? {} : { threadsUserId: duplicate.threadsUserId }),
    };
    assertValidTombstone(tombstone);
    Object.defineProperty(storage.tombstones, tombstone.contactId, {
      value: tombstone, enumerable: true, configurable: true, writable: true,
    });

    for (const [key, value] of Object.entries(storage.identityIndex)) {
      if (value === duplicate.id) delete storage.identityIndex[key];
    }
  }

  delete storage.identityConflicts[input.conflictId];

  return { type: "resolved", contact: updatedCanonical };
}
