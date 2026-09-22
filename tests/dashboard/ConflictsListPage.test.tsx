import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";

import { ConflictsListPage } from "../../src/dashboard/routes/ConflictsListPage";
import type { ThreadContact } from "../../src/domain/contact";
import type { IdentityConflict } from "../../src/domain/conflict";
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

function renderList(store: FakeDashboardStore) {
  const router = createTestRouter(
    [
      { path: "/conflicts", element: <ConflictsListPage store={store} /> },
      { path: "/conflicts/:conflictId", element: <div data-testid="review-route" /> },
    ],
    "/conflicts",
  );
  render(<RouterProvider router={router} />);
  return router;
}

afterEach(() => {
  cleanup();
});

describe("ConflictsListPage", () => {
  it("shows the no-pending-conflicts empty state", () => {
    renderList(new FakeDashboardStore([]));

    expect(screen.getByText(t("dashboard_conflicts_emptyTitle"))).toBeTruthy();
  });

  it("summarizes each pending conflict without exposing its internal id", () => {
    const canonical = contact({ id: "canonical", threadsUserId: "123", username: "old", nickname: "Old Name" });
    const duplicate = contact({ id: "duplicate", username: "new" });
    const conflict: IdentityConflict = {
      id: "a1b2c3d4-conflict-id",
      threadsUserId: "123",
      contactIds: [canonical.id, duplicate.id],
      detectedAt: "2026-01-02T00:00:00.000Z",
    };
    renderList(new FakeDashboardStore([canonical, duplicate], [conflict]));

    expect(screen.getByText("Old Name")).toBeTruthy();
    expect(screen.getByText("@old")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.queryByText("a1b2c3d4-conflict-id")).toBeNull();
  });

  it("sorts conflicts by detectedAt descending", () => {
    const older = contact({ id: "older-canonical", threadsUserId: "1", nickname: "Older" });
    const olderDup = contact({ id: "older-dup" });
    const newer = contact({ id: "newer-canonical", threadsUserId: "2", nickname: "Newer" });
    const newerDup = contact({ id: "newer-dup" });
    const olderConflict: IdentityConflict = {
      id: "c1",
      threadsUserId: "1",
      contactIds: [older.id, olderDup.id],
      detectedAt: "2026-01-01T00:00:00.000Z",
    };
    const newerConflict: IdentityConflict = {
      id: "c2",
      threadsUserId: "2",
      contactIds: [newer.id, newerDup.id],
      detectedAt: "2026-01-05T00:00:00.000Z",
    };
    renderList(new FakeDashboardStore([older, olderDup, newer, newerDup], [olderConflict, newerConflict]));

    const rows = screen.getAllByRole("row").slice(1);
    expect(rows[0].textContent).toContain("Newer");
    expect(rows[1].textContent).toContain("Older");
  });

  it("routes the resolve action to the specific conflict's review page", () => {
    const canonical = contact({ id: "canonical", threadsUserId: "123" });
    const duplicate = contact({ id: "duplicate" });
    const conflict: IdentityConflict = {
      id: "conflict-1",
      threadsUserId: "123",
      contactIds: [canonical.id, duplicate.id],
      detectedAt: "2026-01-02T00:00:00.000Z",
    };
    const router = renderList(new FakeDashboardStore([canonical, duplicate], [conflict]));

    fireEvent.click(screen.getByRole("button", { name: t("dashboard_directory_resolveConflictAction") }));

    expect(router.state.location.pathname).toBe("/conflicts/conflict-1");
  });
});
