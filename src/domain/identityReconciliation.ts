import type { ThreadContact } from "./contact";
import type { IdentityConflict } from "./conflict";

/**
 * Rebuilds identityIndex/identityConflicts from scratch against a candidate
 * contact set (Phase 3 §41). A `threadsUserId` shared by 2+ active contacts
 * never gets a `threads:<id>` index entry - which of them is canonical isn't
 * decided until a human resolves the resulting IdentityConflict, so this
 * must not pick one arbitrarily.
 */
export function reconcileIdentityDerivedState(input: {
  contacts: ReadonlyMap<string, ThreadContact>;
  existingConflicts: ReadonlyMap<string, IdentityConflict>;
  now: string;
}): {
  identityIndex: Record<string, string>;
  identityConflicts: Record<string, IdentityConflict>;
} {
  const identityIndex: Record<string, string> = {};
  for (const contact of input.contacts.values()) {
    identityIndex[`username:${contact.username}`] = contact.id;
  }

  const byThreadsUserId = new Map<string, ThreadContact[]>();
  for (const contact of input.contacts.values()) {
    if (contact.threadsUserId === undefined) continue;
    const group = byThreadsUserId.get(contact.threadsUserId) ?? [];
    group.push(contact);
    byThreadsUserId.set(contact.threadsUserId, group);
  }

  const existingConflicts = [...input.existingConflicts.values()];
  const identityConflicts: Record<string, IdentityConflict> = {};

  for (const [threadsUserId, contacts] of byThreadsUserId) {
    if (contacts.length === 1) {
      identityIndex[`threads:${threadsUserId}`] = contacts[0].id;
      continue;
    }

    const contactIds = contacts.map((contact) => contact.id).sort();
    const sameSourceSet = existingConflicts.find(
      (conflict) =>
        conflict.threadsUserId === threadsUserId &&
        conflict.contactIds.length === contactIds.length &&
        [...conflict.contactIds].sort().every((id, index) => id === contactIds[index]),
    );

    const conflict: IdentityConflict = sameSourceSet ?? {
      id: crypto.randomUUID(),
      threadsUserId,
      contactIds,
      detectedAt: input.now,
    };
    identityConflicts[conflict.id] = conflict;
  }

  return { identityIndex, identityConflicts };
}
