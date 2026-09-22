import { describe, expect, it } from "vitest";

import { paginateContacts } from "../../src/dashboard/directory/paginateContacts";

const items = Array.from({ length: 12 }, (_, index) => index);

describe("paginateContacts", () => {
  it("returns the first page by default page size", () => {
    const result = paginateContacts(items, 1, 50);

    expect(result).toEqual({
      items,
      page: 1,
      pageSize: 50,
      totalItems: 12,
      totalPages: 1,
    });
  });

  it("slices a page of the requested size", () => {
    const result = paginateContacts(items, 2, 5);

    expect(result.items).toEqual([5, 6, 7, 8, 9]);
    expect(result.totalPages).toBe(3);
  });

  it("clamps a page below 1 up to 1", () => {
    expect(paginateContacts(items, 0, 5).page).toBe(1);
    expect(paginateContacts(items, -3, 5).page).toBe(1);
  });

  it("clamps a page past the end down to the last page", () => {
    const result = paginateContacts(items, 99, 5);

    expect(result.page).toBe(3);
    expect(result.items).toEqual([10, 11]);
  });

  it("treats an empty collection as a single empty page", () => {
    const result = paginateContacts([], 1, 25);

    expect(result).toEqual({ items: [], page: 1, pageSize: 25, totalItems: 0, totalPages: 1 });
  });
});
