import type { ThreadContact } from "../../domain/contact";

/** Substring search across nickname, username, and note, trimmed and locale-lowercased. */
export function filterContacts(contacts: ThreadContact[], query: string): ThreadContact[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return contacts;

  return contacts.filter((contact) =>
    [contact.nickname, contact.username, contact.note ?? ""].some((field) =>
      field.toLocaleLowerCase().includes(normalizedQuery),
    ),
  );
}
