export type ContactPageSize = 25 | 50 | 100;

export const CONTACT_PAGE_SIZES: readonly ContactPageSize[] = [25, 50, 100];
export const DEFAULT_CONTACT_PAGE_SIZE: ContactPageSize = 50;

export interface PaginatedContacts<T> {
  items: T[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

/** Clamps `page` into range so a shrinking result set never strands the caller on a dead page. */
export function paginateContacts<T>(
  items: readonly T[],
  page: number,
  pageSize: ContactPageSize,
): PaginatedContacts<T> {
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const clampedPage = Math.min(Math.max(1, page), totalPages);
  const start = (clampedPage - 1) * pageSize;

  return {
    items: items.slice(start, start + pageSize),
    page: clampedPage,
    pageSize,
    totalItems,
    totalPages,
  };
}
