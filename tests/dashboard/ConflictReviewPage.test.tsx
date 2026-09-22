import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { RouterProvider } from "react-router-dom";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConflictReviewPage } from "../../src/dashboard/routes/ConflictReviewPage";
import type { ThreadContact } from "../../src/domain/contact";
import type { IdentityConflict } from "../../src/domain/conflict";
import type {
  ResolveConflictInput,
  ResolveConflictResult,
} from "../../src/domain/resolveIdentityConflict";
import { t } from "../../src/i18n/t";
import type { ContactsRepository } from "../../src/storage/ContactsRepository";
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

class RecordingRepository implements Partial<ContactsRepository> {
  readonly calls: ResolveConflictInput[] = [];
  implementation: (input: ResolveConflictInput) => Promise<ResolveConflictResult> = async () => ({
    type: "resolved",
    contact: contact({ id: "canonical" }),
  });

  async resolveConflict(_owner: string, input: ResolveConflictInput): Promise<ResolveConflictResult> {
    this.calls.push(input);
    return this.implementation(input);
  }
}

function renderReview(
  store: FakeDashboardStore,
  repository: RecordingRepository,
  conflictId = "conflict-1",
  clock: () => string = () => "2026-01-03T00:00:00.000Z",
) {
  const router = createTestRouter(
    [
      {
        path: "/conflicts/:conflictId",
        element: (
          <ConflictReviewPage
            ownerThreadsUserId="900"
            store={store}
            repository={repository as unknown as ContactsRepository}
            clock={clock}
          />
        ),
      },
      { path: "/conflicts", element: <div data-testid="conflicts-list-route" /> },
    ],
    `/conflicts/${conflictId}`,
  );
  render(<RouterProvider router={router} />);
  return router;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ConflictReviewPage", () => {
  it("stacks both sources vertically, identifies the canonical one, and defaults the final form", () => {
    const canonical = contact({
      id: "canonical",
      threadsUserId: "123",
      username: "old",
      nickname: "Old Name",
      note: "Canonical note",
    });
    const duplicate = contact({ id: "duplicate", username: "new", nickname: "New Name", note: "Duplicate note" });
    const conflict: IdentityConflict = {
      id: "conflict-1",
      threadsUserId: "123",
      contactIds: [canonical.id, duplicate.id],
      detectedAt: "2026-01-02T00:00:00.000Z",
    };
    renderReview(new FakeDashboardStore([canonical, duplicate], [conflict]), new RecordingRepository());
    const sourceList = within(screen.getByTestId("conflict-sources"));

    expect(sourceList.getByText("@old")).toBeTruthy();
    expect(sourceList.getByText("@new")).toBeTruthy();
    expect(sourceList.getByText("Canonical note")).toBeTruthy();
    expect(sourceList.getByText("Duplicate note")).toBeTruthy();
    expect(sourceList.getByText(t("dashboard_conflicts_canonicalBadge"))).toBeTruthy();

    expect((screen.getByLabelText(t("dashboard_conflicts_finalNicknameLabel")) as HTMLInputElement).value).toBe(
      "Old Name",
    );
    expect((screen.getByLabelText(t("dashboard_conflicts_finalNoteLabel")) as HTMLTextAreaElement).value).toBe(
      "Canonical note\n\nDuplicate note",
    );
  });

  it("stacks 3+ sources with exactly one canonical badge", () => {
    const canonical = contact({ id: "canonical", threadsUserId: "123", username: "old" });
    const dupA = contact({ id: "dup-a", username: "alias-a" });
    const dupB = contact({ id: "dup-b", username: "alias-b" });
    const conflict: IdentityConflict = {
      id: "conflict-1",
      threadsUserId: "123",
      contactIds: [canonical.id, dupA.id, dupB.id],
      detectedAt: "2026-01-02T00:00:00.000Z",
    };
    renderReview(new FakeDashboardStore([canonical, dupA, dupB], [conflict]), new RecordingRepository());
    const sourceList = within(screen.getByTestId("conflict-sources"));

    expect(sourceList.getByText("@old")).toBeTruthy();
    expect(sourceList.getByText("@alias-a")).toBeTruthy();
    expect(sourceList.getByText("@alias-b")).toBeTruthy();
    expect(sourceList.getAllByText(t("dashboard_conflicts_canonicalBadge"))).toHaveLength(1);
  });

  it("shows a visible, localized error for an invalid nickname, associated to the input via aria-describedby", () => {
    const canonical = contact({ id: "canonical", threadsUserId: "123", nickname: "Old" });
    const duplicate = contact({ id: "duplicate" });
    const conflict: IdentityConflict = {
      id: "conflict-1",
      threadsUserId: "123",
      contactIds: [canonical.id, duplicate.id],
      detectedAt: "2026-01-02T00:00:00.000Z",
    };
    renderReview(new FakeDashboardStore([canonical, duplicate], [conflict]), new RecordingRepository());
    const input = screen.getByLabelText(t("dashboard_conflicts_finalNicknameLabel")) as HTMLInputElement;

    expect(screen.queryByText(t("profile_nicknameInvalid"))).toBeNull();

    fireEvent.change(input, { target: { value: "a".repeat(26) } });

    const errorId = input.getAttribute("aria-describedby");
    expect(errorId).toBeTruthy();
    const errorNode = document.getElementById(errorId!);
    expect(errorNode?.textContent).toBe(t("profile_nicknameInvalid"));
  });

  it("disables merge and shows an error when the note draft exceeds 200 characters", () => {
    const canonical = contact({ id: "canonical", threadsUserId: "123" });
    const duplicate = contact({ id: "duplicate" });
    const conflict: IdentityConflict = {
      id: "conflict-1",
      threadsUserId: "123",
      contactIds: [canonical.id, duplicate.id],
      detectedAt: "2026-01-02T00:00:00.000Z",
    };
    renderReview(new FakeDashboardStore([canonical, duplicate], [conflict]), new RecordingRepository());

    fireEvent.change(screen.getByLabelText(t("dashboard_conflicts_finalNoteLabel")), {
      target: { value: "a".repeat(201) },
    });

    expect(screen.getByText(t("dashboard_drawer_noteInvalid"))).toBeTruthy();
    expect((screen.getByRole("button", { name: t("dashboard_conflicts_mergeAction") }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("submits the merge with the captured expected timestamps, toasts, and navigates back", async () => {
    const canonical = contact({ id: "canonical", threadsUserId: "123", nickname: "Old" });
    const duplicate = contact({ id: "duplicate", nickname: "Dup" });
    const conflict: IdentityConflict = {
      id: "conflict-1",
      threadsUserId: "123",
      contactIds: [canonical.id, duplicate.id],
      detectedAt: "2026-01-02T00:00:00.000Z",
    };
    const repository = new RecordingRepository();
    const success = vi.spyOn(toast, "success").mockReturnValue("toast-id");
    const router = renderReview(new FakeDashboardStore([canonical, duplicate], [conflict]), repository);

    fireEvent.change(screen.getByLabelText(t("dashboard_conflicts_finalNicknameLabel")), {
      target: { value: "Merged" },
    });
    fireEvent.click(screen.getByRole("button", { name: t("dashboard_conflicts_mergeAction") }));
    await act(async () => {});

    expect(repository.calls).toEqual([
      {
        conflictId: "conflict-1",
        nickname: "Merged",
        note: "",
        expectedSources: [
          { contactId: "canonical", updatedAt: canonical.updatedAt, identityUpdatedAt: canonical.identityUpdatedAt },
          { contactId: "duplicate", updatedAt: duplicate.updatedAt, identityUpdatedAt: duplicate.identityUpdatedAt },
        ],
        now: "2026-01-03T00:00:00.000Z",
      },
    ]);
    expect(success).toHaveBeenCalledWith(t("dashboard_conflicts_mergeSuccess"));
    expect(router.state.location.pathname).toBe("/conflicts");
  });

  it("blocks the merge and offers a reload when the service reports stale data", async () => {
    const canonical = contact({ id: "canonical", threadsUserId: "123", nickname: "Old" });
    const duplicate = contact({ id: "duplicate" });
    const conflict: IdentityConflict = {
      id: "conflict-1",
      threadsUserId: "123",
      contactIds: [canonical.id, duplicate.id],
      detectedAt: "2026-01-02T00:00:00.000Z",
    };
    const repository = new RecordingRepository();
    repository.implementation = async () => ({ type: "stale" });
    const router = renderReview(new FakeDashboardStore([canonical, duplicate], [conflict]), repository);

    fireEvent.click(screen.getByRole("button", { name: t("dashboard_conflicts_mergeAction") }));
    await act(async () => {});

    expect(screen.getByText(t("dashboard_conflicts_staleError"))).toBeTruthy();
    expect(screen.getByRole("button", { name: t("dashboard_drawer_reloadLatest") })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/conflicts/conflict-1");
  });

  it("redirects to the conflicts list when the conflict no longer exists", async () => {
    const router = renderReview(new FakeDashboardStore([], []), new RecordingRepository(), "vanished");

    expect(await screen.findByTestId("conflicts-list-route")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/conflicts");
  });
});
