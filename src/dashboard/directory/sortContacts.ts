import type { ThreadContact } from "../../domain/contact";

export type ContactSortOption =
  | "updated_desc"
  | "updated_asc"
  | "nickname_asc"
  | "nickname_desc"
  | "username_asc"
  | "username_desc";

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

export function sortContacts(contacts: ThreadContact[], sort: ContactSortOption): ThreadContact[] {
  const sorted = [...contacts];

  switch (sort) {
    case "updated_desc":
      return sorted.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    case "updated_asc":
      return sorted.sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0));
    case "nickname_asc":
      return sorted.sort((a, b) => collator.compare(a.nickname, b.nickname));
    case "nickname_desc":
      return sorted.sort((a, b) => collator.compare(b.nickname, a.nickname));
    case "username_asc":
      return sorted.sort((a, b) => collator.compare(a.username, b.username));
    case "username_desc":
      return sorted.sort((a, b) => collator.compare(b.username, a.username));
  }
}
