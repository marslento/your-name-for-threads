import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CONTACT_PAGE_SIZE } from "../../src/dashboard/directory/paginateContacts";
import { filterContacts } from "../../src/dashboard/directory/filterContacts";
import { sortContacts, type ContactSortOption } from "../../src/dashboard/directory/sortContacts";
import { DirectoryPage } from "../../src/dashboard/routes/DirectoryPage";
import type { IdentityConflict } from "../../src/domain/conflict";
import type { ThreadContact } from "../../src/domain/contact";
import type { ContactsRepository } from "../../src/storage/ContactsRepository";
import { t } from "../../src/i18n/t";
import { createTestRouter } from "./testRouter";

/**
 * A Directory of about a thousand contacts (Phase 4 Task 24; design summary section 22): the page shows one page of
 * rows however many contacts there are, and search and sort stay cheap. The measure is what the page does, not how
 * fast this machine is: the timing check has a budget dozens of times what it needs, so it only catches a change that
 * makes the work explode. How it feels in a real browser is the manual checklist's job (docs/release/performance-checklist.md).
 */
const CONTACTS = 1000;

function contact(index: number): ThreadContact {
  const stamp = `2026-03-${String((index % 28) + 1).padStart(2, "0")}T00:${String(index % 60).padStart(2, "0")}:00.000Z`;
  return {
    id: `contact-${index}`,
    username: `user_${String(index).padStart(4, "0")}`,
    threadsUserId: String(10_000 + index),
    nickname: `Nickname ${index}`,
    note: index % 5 === 0 ? `note about number ${index}` : undefined,
    createdAt: stamp,
    updatedAt: stamp,
    identityUpdatedAt: stamp,
  };
}
const directory = Array.from({ length: CONTACTS }, (_, index) => contact(index));

const noConflicts: IdentityConflict[] = []; // one array: a store must hand back the same snapshot until something changes

class Store {
  getContacts = () => directory;
  getConflicts = () => noConflicts;
  getSettings = () => ({ enabled: true, nicknameDisplay: { profile: true, feed: true, replies: true, quotes: true } });
  isLoaded = () => true;
  subscribe = () => () => {};
}

function renderDirectory() {
  const router = createTestRouter([{ path: "/directory", element: <DirectoryPage store={new Store()} repository={{} as unknown as ContactsRepository} /> }], "/directory");
  render(<RouterProvider router={router} />);
}

const bodyRows = () => screen.getAllByRole("row").length - 1; // the header row is one

afterEach(() => {
  cleanup();
});

describe("a Directory of a thousand contacts", () => {
  it("shows one page of rows, not a thousand, and says how many contacts there are", () => {
    renderDirectory();

    expect(screen.getByText(t("dashboard_directory_countLabel", [String(CONTACTS)]))).toBeTruthy();
    expect(bodyRows()).toBe(DEFAULT_CONTACT_PAGE_SIZE);
    expect(document.querySelectorAll("tr").length).toBeLessThan(CONTACTS / 4);
  });

  it("(control) has the rows to show: a second page exists and shows different ones", () => {
    renderDirectory();
    const firstPage = screen.getAllByRole("row")[1].textContent;

    fireEvent.click(screen.getByRole("button", { name: t("dashboard_directory_nextPage") }));

    expect(bodyRows()).toBe(DEFAULT_CONTACT_PAGE_SIZE);
    expect(screen.getAllByRole("row")[1].textContent).not.toBe(firstPage);
  });

  it("still shows only the matching rows after a search, and waits for the typing to pause before filtering", async () => {
    renderDirectory();
    const search = screen.getByLabelText(t("dashboard_directory_searchPlaceholder"));

    fireEvent.change(search, { target: { value: "note about number 995" } }); // a substring of exactly one note
    expect(bodyRows(), "typing alone filters nothing yet").toBe(DEFAULT_CONTACT_PAGE_SIZE);

    await act(async () => new Promise((resolve) => setTimeout(resolve, 260)));

    expect(bodyRows()).toBe(1);
  });

  it.each(["updated_desc", "updated_asc", "nickname_asc", "nickname_desc", "username_asc", "username_desc"] as ContactSortOption[])(
    "searches and sorts by %s within a generous budget, and loses no contact",
    (sort) => {
      const started = performance.now();
      const found = filterContacts(directory, "number 1");
      const sorted = sortContacts(filterContacts(directory, ""), sort);
      const elapsed = performance.now() - started;

      expect(found.length).toBeGreaterThan(0);
      expect(sorted).toHaveLength(CONTACTS);
      expect(new Set(sorted.map((c) => c.id)).size).toBe(CONTACTS);
      expect(elapsed, `${Math.round(elapsed)} ms for a search and a sort of ${CONTACTS} contacts`).toBeLessThan(500);
    },
  );
});
