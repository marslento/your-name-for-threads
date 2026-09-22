import type { ThreadContact } from "../../domain/contact";
import type { IdentityConflict } from "../../domain/conflict";
import { selectCanonicalContact } from "../../domain/conflictCanonical";

export interface DirectoryConflictInfo {
  /** Active contacts with every non-canonical conflict participant hidden. */
  visibleContacts: ThreadContact[];
  /** Canonical contact id -> the pending conflict naming it, for the "resolve" action/badge. */
  pendingConflictByContactId: Map<string, string>;
}

/**
 * A conflict's canonical contact (the numeric-ID owner) stays visible with a
 * pending badge; every other contact it names is a duplicate and is hidden
 * from the Directory entirely until a human resolves the conflict.
 */
export function resolveDirectoryConflicts(
  contacts: ThreadContact[],
  conflicts: IdentityConflict[],
): DirectoryConflictInfo {
  const contactsById = new Map(contacts.map((contact) => [contact.id, contact]));
  const duplicateIds = new Set<string>();
  const pendingConflictByContactId = new Map<string, string>();

  for (const conflict of conflicts) {
    const members = conflict.contactIds
      .map((id) => contactsById.get(id))
      .filter((contact): contact is ThreadContact => contact !== undefined);
    const canonical = selectCanonicalContact(conflict, members);
    if (!canonical) continue;

    pendingConflictByContactId.set(canonical.id, conflict.id);
    for (const member of members) {
      if (member.id !== canonical.id) duplicateIds.add(member.id);
    }
  }

  return {
    visibleContacts: contacts.filter((contact) => !duplicateIds.has(contact.id)),
    pendingConflictByContactId,
  };
}
