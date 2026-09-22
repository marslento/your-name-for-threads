import { act } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DirectoryPage } from "../../src/dashboard/routes/DirectoryPage";
import type { ThreadContact } from "../../src/domain/contact";
import type { IdentityConflict } from "../../src/domain/conflict";
import type { ContactsRepository } from "../../src/storage/ContactsRepository";
import { t } from "../../src/i18n/t";
import { createTestRouter } from "./testRouter";

function contact(overrides: Partial<ThreadContact> & { id: string }): ThreadContact {
  return {
    username: overrides.id,
    nickname: overrides.id,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    identityUpdatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

class FakeDashboardStore {
  private listeners = new Set<() => void>();

  constructor(
    private contacts: ThreadContact[] = [],
    private conflicts: IdentityConflict[] = [],
  ) {}

  getContacts = () => this.contacts;
  getConflicts = () => this.conflicts;
  getSettings = () => ({ enabled: true, nicknameDisplay: { profile: true, feed: true, replies: true, quotes: true } });
  isLoaded = () => true;

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function unimplementedRepository(): ContactsRepository {
  const fail = (name: string) => () => {
    throw new Error(`Unexpected repository call: ${name}`);
  };
  return {
    getByIdentity: fail("getByIdentity"),
    getById: fail("getById"),
    hasPendingConflict: fail("hasPendingConflict"),
    listActive: fail("listActive"),
    upsertNickname: fail("upsertNickname"),
    updateContactDetails: fail("updateContactDetails"),
    deleteContact: fail("deleteContact"),
    attachStableIdentity: fail("attachStableIdentity"),
    resolveConflict: fail("resolveConflict"),
    cacheIdentityObservation: fail("cacheIdentityObservation"),
    getCachedIdentity: fail("getCachedIdentity"),
    pruneIdentityCache: fail("pruneIdentityCache"),
  } as unknown as ContactsRepository;
}

function renderDirectory(store: FakeDashboardStore) {
  const router = createTestRouter(
    [
      { path: "/directory", element: <DirectoryPage store={store} repository={unimplementedRepository()} /> },
      { path: "/conflicts", element: <div data-testid="conflicts-route" /> },
      { path: "/conflicts/:conflictId", element: <div data-testid="conflict-review-route" /> },
    ],
    "/directory",
  );
  render(<RouterProvider router={router} />);
  return router;
}

afterEach(() => {
  cleanup();
});

describe("DirectoryPage", () => {
  it("shows the contact count for visible contacts only", () => {
    renderDirectory(new FakeDashboardStore([contact({ id: "alice" }), contact({ id: "bob" })]));

    expect(screen.getByText(t("dashboard_directory_countLabel", ["2"]))).toBeTruthy();
  });

  it("shows the empty state with an Open Threads link when there are no contacts", () => {
    renderDirectory(new FakeDashboardStore([]));

    expect(screen.getByText(t("dashboard_directory_emptyTitle"))).toBeTruthy();
    const link = screen.getByRole("link", { name: t("dashboard_directory_emptyAction") }) as HTMLAnchorElement;
    expect(link.href).toBe("https://www.threads.com/");
    expect(link.target).toBe("_blank");
  });

  it("hides the conflict banner when there are no pending conflicts", () => {
    renderDirectory(new FakeDashboardStore([contact({ id: "alice" })]));

    expect(screen.queryByText(t("dashboard_directory_conflictBannerAction"))).toBeNull();
  });

  it("shows the conflict banner with a count and routes to #/conflicts", () => {
    const canonical = contact({ id: "canonical", threadsUserId: "123" });
    const duplicate = contact({ id: "duplicate" });
    const conflict: IdentityConflict = {
      id: "conflict-1",
      threadsUserId: "123",
      contactIds: [canonical.id, duplicate.id],
      detectedAt: "2026-01-02T00:00:00.000Z",
    };
    const router = renderDirectory(new FakeDashboardStore([canonical, duplicate], [conflict]));

    expect(screen.getByText(t("dashboard_directory_conflictBannerLabel", ["1"]))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t("dashboard_directory_conflictBannerAction") }));
    expect(router.state.location.pathname).toBe("/conflicts");
  });

  it("hides the duplicate contact and shows only the canonical row with a pending badge", () => {
    const canonical = contact({ id: "canonical", threadsUserId: "123", nickname: "Canonical" });
    const duplicate = contact({ id: "duplicate", nickname: "Duplicate" });
    const conflict: IdentityConflict = {
      id: "conflict-1",
      threadsUserId: "123",
      contactIds: [canonical.id, duplicate.id],
      detectedAt: "2026-01-02T00:00:00.000Z",
    };
    renderDirectory(new FakeDashboardStore([canonical, duplicate], [conflict]));

    expect(screen.getByText("Canonical")).toBeTruthy();
    expect(screen.queryByText("Duplicate")).toBeNull();
    expect(screen.getByText(t("dashboard_directory_countLabel", ["1"]))).toBeTruthy();
  });

  it("routes the resolve-conflict action to the specific conflict review page", () => {
    const canonical = contact({ id: "canonical", threadsUserId: "123" });
    const duplicate = contact({ id: "duplicate" });
    const conflict: IdentityConflict = {
      id: "conflict-1",
      threadsUserId: "123",
      contactIds: [canonical.id, duplicate.id],
      detectedAt: "2026-01-02T00:00:00.000Z",
    };
    const router = renderDirectory(new FakeDashboardStore([canonical, duplicate], [conflict]));

    fireEvent.click(screen.getByRole("button", { name: t("dashboard_directory_resolveConflictAction") }));

    expect(router.state.location.pathname).toBe("/conflicts/conflict-1");
  });

  it("shows the search-empty state (after the debounce settles) and clears the search on request", () => {
    vi.useFakeTimers();
    try {
      renderDirectory(new FakeDashboardStore([contact({ id: "alice", nickname: "Alice" })]));

      fireEvent.change(screen.getByPlaceholderText(t("dashboard_directory_searchPlaceholder")), {
        target: { value: "nonexistent" },
      });
      act(() => {
        vi.runAllTimers();
      });
      expect(screen.getByText(t("dashboard_directory_searchEmptyTitle"))).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: t("dashboard_directory_searchEmptyAction") }));
      expect(screen.getByText("Alice")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not recompute the filtered list until the debounce settles, so rapid typing only filters once for the final query", () => {
    vi.useFakeTimers();
    try {
      renderDirectory(
        new FakeDashboardStore([contact({ id: "alice", nickname: "Alice" }), contact({ id: "bob", nickname: "Bob" })]),
      );
      const input = screen.getByPlaceholderText(t("dashboard_directory_searchPlaceholder"));

      fireEvent.change(input, { target: { value: "b" } });
      fireEvent.change(input, { target: { value: "bo" } });
      fireEvent.change(input, { target: { value: "bob" } });

      // The input itself must reflect every keystroke immediately.
      expect((input as HTMLInputElement).value).toBe("bob");
      // But filtering (and therefore the row list) must not have reacted yet.
      expect(screen.getByText("Alice")).toBeTruthy();

      act(() => {
        vi.runAllTimers();
      });

      expect(screen.queryByText("Alice")).toBeNull();
      expect(screen.getByText("Bob")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
