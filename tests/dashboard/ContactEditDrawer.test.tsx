import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Link, RouterProvider } from "react-router-dom";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContactEditDrawer } from "../../src/dashboard/directory/ContactEditDrawer";
import type { ThreadContact } from "../../src/domain/contact";
import type { ContactTombstone } from "../../src/domain/tombstone";
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

class RecordingRepository implements ContactsRepository {
  readonly updateCalls: Array<{ id: string; nickname: string; note: string; now: string }> = [];
  readonly deleteCalls: Array<{ id: string; now: string }> = [];
  updateImplementation: (input: {
    id: string;
    nickname: string;
    note: string;
    now: string;
  }) => Promise<ThreadContact> = async (input) => contact({ id: input.id, nickname: input.nickname, note: input.note || undefined, updatedAt: input.now });
  deleteImplementation: (input: { id: string; now: string }) => Promise<ContactTombstone> = async (input) => ({
    contactId: input.id,
    username: "alice",
    createdAt: "2026-01-01T00:00:00.000Z",
    deletedAt: input.now,
    reason: "user_deleted",
  });

  async getByIdentity(): Promise<ThreadContact | null> {
    throw new Error("Unexpected call");
  }
  async getById(): Promise<ThreadContact | null> {
    throw new Error("Unexpected call");
  }
  async hasPendingConflict(): Promise<boolean> {
    throw new Error("Unexpected call");
  }
  async listActive(): Promise<ThreadContact[]> {
    throw new Error("Unexpected call");
  }
  async upsertNickname(): Promise<ThreadContact> {
    throw new Error("Unexpected call");
  }
  async updateContactDetails(_owner: string, input: { id: string; nickname: string; note: string; now: string }): Promise<ThreadContact> {
    this.updateCalls.push(input);
    return this.updateImplementation(input);
  }
  async deleteContact(_owner: string, input: { id: string; now: string }): Promise<ContactTombstone> {
    this.deleteCalls.push(input);
    return this.deleteImplementation(input);
  }
  async attachStableIdentity(): Promise<never> {
    throw new Error("Unexpected call");
  }
  async resolveConflict(): Promise<never> {
    throw new Error("Unexpected call");
  }
  async cacheIdentityObservation(): Promise<never> {
    throw new Error("Unexpected call");
  }
  async getCachedIdentity(): Promise<null> {
    return null;
  }
  async pruneIdentityCache(): Promise<number> {
    return 0;
  }
}

function renderDrawer(props: {
  contactId: string | null;
  liveContact: ThreadContact | null;
  repository: ContactsRepository;
  clock?: () => string;
  onClose?: () => void;
}) {
  const onClose = props.onClose ?? vi.fn();
  function Harness() {
    return (
      <>
        <Link to="/elsewhere">Navigate Away</Link>
        <ContactEditDrawer
          ownerThreadsUserId="900"
          contactId={props.contactId}
          liveContact={props.liveContact}
          repository={props.repository}
          clock={props.clock ?? (() => "2026-01-02T00:00:00.000Z")}
          onClose={onClose}
        />
      </>
    );
  }
  const router = createTestRouter(
    [
      { path: "/directory", element: <Harness /> },
      { path: "/elsewhere", element: <div data-testid="elsewhere-route" /> },
    ],
    "/directory",
  );
  render(<RouterProvider router={router} />);
  return { router, onClose };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ContactEditDrawer: editing and validation", () => {
  it("disables Save until the form becomes dirty", () => {
    const alice = contact({ id: "alice", nickname: "Alice" });
    renderDrawer({ contactId: "alice", liveContact: alice, repository: new RecordingRepository() });

    expect((screen.getByRole("button", { name: t("profile_saveNickname") }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(t("profile_nicknameLabel")), { target: { value: "Ally" } });

    expect((screen.getByRole("button", { name: t("profile_saveNickname") }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("disables Save for an empty or over-length nickname", () => {
    const alice = contact({ id: "alice", nickname: "Alice" });
    renderDrawer({ contactId: "alice", liveContact: alice, repository: new RecordingRepository() });
    const input = screen.getByLabelText(t("profile_nicknameLabel"));
    const save = screen.getByRole("button", { name: t("profile_saveNickname") }) as HTMLButtonElement;

    fireEvent.change(input, { target: { value: "   " } });
    expect(save.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "a".repeat(26) } });
    expect(save.disabled).toBe(true);
  });

  it("shows a visible, localized error for an invalid nickname, associated to the input via aria-describedby", () => {
    const alice = contact({ id: "alice", nickname: "Alice" });
    renderDrawer({ contactId: "alice", liveContact: alice, repository: new RecordingRepository() });
    const input = screen.getByLabelText(t("profile_nicknameLabel")) as HTMLInputElement;

    expect(screen.queryByText(t("profile_nicknameInvalid"))).toBeNull();

    fireEvent.change(input, { target: { value: "a".repeat(26) } });

    const errorId = input.getAttribute("aria-describedby");
    expect(errorId).toBeTruthy();
    const errorNode = document.getElementById(errorId!);
    expect(errorNode?.textContent).toBe(t("profile_nicknameInvalid"));
  });

  it("disables Save and shows an error for a note over 200 characters", () => {
    const alice = contact({ id: "alice" });
    renderDrawer({ contactId: "alice", liveContact: alice, repository: new RecordingRepository() });

    fireEvent.change(screen.getByLabelText(t("dashboard_drawer_noteLabel")), {
      target: { value: "a".repeat(201) },
    });

    expect(screen.getByText(t("dashboard_drawer_noteInvalid"))).toBeTruthy();
    expect((screen.getByRole("button", { name: t("profile_saveNickname") }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("saves only nickname/note, resets dirty state, and toasts success", async () => {
    const alice = contact({ id: "alice", nickname: "Alice" });
    const repository = new RecordingRepository();
    const success = vi.spyOn(toast, "success").mockReturnValue("toast-id");
    renderDrawer({ contactId: "alice", liveContact: alice, repository, clock: () => "2026-02-01T00:00:00.000Z" });

    fireEvent.change(screen.getByLabelText(t("profile_nicknameLabel")), { target: { value: "Ally" } });
    fireEvent.change(screen.getByLabelText(t("dashboard_drawer_noteLabel")), { target: { value: "A note" } });
    fireEvent.click(screen.getByRole("button", { name: t("profile_saveNickname") }));
    await act(async () => {});

    expect(repository.updateCalls).toEqual([
      { id: "alice", nickname: "Ally", note: "A note", now: "2026-02-01T00:00:00.000Z" },
    ]);
    expect(success).toHaveBeenCalledWith(t("dashboard_drawer_saveSuccess"));
    expect((screen.getByRole("button", { name: t("profile_saveNickname") }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("ContactEditDrawer: unsaved-changes protection", () => {
  it("confirms before discarding on Escape while dirty, and keeps edits when cancelled", () => {
    const alice = contact({ id: "alice", nickname: "Alice" });
    const { onClose } = renderDrawer({ contactId: "alice", liveContact: alice, repository: new RecordingRepository() });
    fireEvent.change(screen.getByLabelText(t("profile_nicknameLabel")), { target: { value: "Ally" } });

    fireEvent.keyDown(document, { key: "Escape" });
    const discardDialog = screen.getByRole("alertdialog");
    expect(within(discardDialog).getByText(t("dashboard_drawer_discardConfirmTitle"))).toBeTruthy();

    fireEvent.click(within(discardDialog).getByRole("button", { name: t("common_cancel") }));
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByLabelText(t("profile_nicknameLabel")) as HTMLInputElement).value).toBe("Ally");
  });

  it("discards and closes when the discard confirmation is accepted", () => {
    const alice = contact({ id: "alice", nickname: "Alice" });
    const { onClose } = renderDrawer({ contactId: "alice", liveContact: alice, repository: new RecordingRepository() });
    fireEvent.change(screen.getByLabelText(t("profile_nicknameLabel")), { target: { value: "Ally" } });

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: t("dashboard_drawer_discardConfirmAction") }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes immediately when there are no unsaved changes", () => {
    const alice = contact({ id: "alice", nickname: "Alice" });
    const { onClose } = renderDrawer({ contactId: "alice", liveContact: alice, repository: new RecordingRepository() });

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(t("dashboard_drawer_discardConfirmTitle"))).toBeNull();
  });

  it("blocks sidebar/browser navigation while dirty and lets it proceed only after confirming", () => {
    const alice = contact({ id: "alice", nickname: "Alice" });
    const { router } = renderDrawer({ contactId: "alice", liveContact: alice, repository: new RecordingRepository() });
    fireEvent.change(screen.getByLabelText(t("profile_nicknameLabel")), { target: { value: "Ally" } });

    fireEvent.click(screen.getByRole("link", { name: "Navigate Away", hidden: true }));
    expect(screen.getByText(t("dashboard_drawer_discardConfirmTitle"))).toBeTruthy();
    expect(router.state.location.pathname).toBe("/directory");

    fireEvent.click(screen.getByRole("button", { name: t("dashboard_drawer_discardConfirmAction") }));
    expect(router.state.location.pathname).toBe("/elsewhere");
  });

  it("keeps the drawer open and edits intact when a blocked navigation is cancelled", () => {
    const alice = contact({ id: "alice", nickname: "Alice" });
    const { router } = renderDrawer({ contactId: "alice", liveContact: alice, repository: new RecordingRepository() });
    fireEvent.change(screen.getByLabelText(t("profile_nicknameLabel")), { target: { value: "Ally" } });

    fireEvent.click(screen.getByRole("link", { name: "Navigate Away", hidden: true }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: t("common_cancel") }));

    expect(router.state.location.pathname).toBe("/directory");
    expect((screen.getByLabelText(t("profile_nicknameLabel")) as HTMLInputElement).value).toBe("Ally");
  });

  it("does not prompt for unsaved changes when deleting a dirty draft", async () => {
    const alice = contact({ id: "alice", nickname: "Alice" });
    const repository = new RecordingRepository();
    const { onClose } = renderDrawer({ contactId: "alice", liveContact: alice, repository });
    fireEvent.change(screen.getByLabelText(t("profile_nicknameLabel")), { target: { value: "Ally" } });

    fireEvent.click(screen.getByRole("button", { name: t("dashboard_drawer_deleteAction") }));
    expect(screen.queryByText(t("dashboard_drawer_discardConfirmTitle"))).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: t("profile_confirmDelete") }));
    await act(async () => {});

    expect(repository.deleteCalls).toEqual([{ id: "alice", now: "2026-01-02T00:00:00.000Z" }]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("ContactEditDrawer: external update/delete concurrency", () => {
  it("silently refreshes the form on an external update while not dirty", () => {
    const alice = contact({ id: "alice", nickname: "Alice" });
    function ControlledHarness({ live }: { live: ThreadContact }) {
      return (
        <ContactEditDrawer
          ownerThreadsUserId="900"
          contactId="alice"
          liveContact={live}
          repository={new RecordingRepository()}
          clock={() => "2026-01-02T00:00:00.000Z"}
          onClose={vi.fn()}
        />
      );
    }
    const router = createTestRouter(
      [{ path: "/directory", element: <ControlledHarness live={alice} /> }],
      "/directory",
    );
    const { rerender } = render(<RouterProvider router={router} />);

    const updated = { ...alice, nickname: "Externally Renamed", updatedAt: "2026-01-01T01:00:00.000Z" };
    const router2 = createTestRouter(
      [{ path: "/directory", element: <ControlledHarness live={updated} /> }],
      "/directory",
    );
    rerender(<RouterProvider router={router2} />);

    expect((screen.getByLabelText(t("profile_nicknameLabel")) as HTMLInputElement).value).toBe("Externally Renamed");
  });

  it("preserves the draft, disables Save, and warns when externally updated while dirty", () => {
    const alice = contact({ id: "alice", nickname: "Alice" });
    function ControlledHarness({ live }: { live: ThreadContact }) {
      return (
        <ContactEditDrawer
          ownerThreadsUserId="900"
          contactId="alice"
          liveContact={live}
          repository={new RecordingRepository()}
          clock={() => "2026-01-02T00:00:00.000Z"}
          onClose={vi.fn()}
        />
      );
    }
    const router = createTestRouter(
      [{ path: "/directory", element: <ControlledHarness live={alice} /> }],
      "/directory",
    );
    const { rerender } = render(<RouterProvider router={router} />);
    fireEvent.change(screen.getByLabelText(t("profile_nicknameLabel")), { target: { value: "My Draft" } });

    const updated = { ...alice, nickname: "Externally Renamed", updatedAt: "2026-01-01T01:00:00.000Z" };
    const router2 = createTestRouter(
      [{ path: "/directory", element: <ControlledHarness live={updated} /> }],
      "/directory",
    );
    rerender(<RouterProvider router={router2} />);

    expect((screen.getByLabelText(t("profile_nicknameLabel")) as HTMLInputElement).value).toBe("My Draft");
    expect(screen.getByText(t("dashboard_drawer_externalUpdateWarning"))).toBeTruthy();
    expect((screen.getByRole("button", { name: t("profile_saveNickname") }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: t("dashboard_drawer_reloadLatest") }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: t("dashboard_drawer_reloadLatest") }),
    );

    expect((screen.getByLabelText(t("profile_nicknameLabel")) as HTMLInputElement).value).toBe("Externally Renamed");
  });

  it("silently refreshes the form on an identity-only external update (rename/numeric-ID attach) while not dirty, even though updatedAt is unchanged", () => {
    const alice = contact({ id: "alice", nickname: "Alice", username: "alice" });
    function ControlledHarness({ live }: { live: ThreadContact }) {
      return (
        <ContactEditDrawer
          ownerThreadsUserId="900"
          contactId="alice"
          liveContact={live}
          repository={new RecordingRepository()}
          clock={() => "2026-01-02T00:00:00.000Z"}
          onClose={vi.fn()}
        />
      );
    }
    const router = createTestRouter(
      [{ path: "/directory", element: <ControlledHarness live={alice} /> }],
      "/directory",
    );
    const { rerender } = render(<RouterProvider router={router} />);

    // Only the identity clock moves - user-owned fields (nickname, note,
    // updatedAt) are untouched, matching a pure rename/numeric-ID attach.
    const updated = { ...alice, username: "alice_renamed", identityUpdatedAt: "2026-01-01T01:00:00.000Z" };
    const router2 = createTestRouter(
      [{ path: "/directory", element: <ControlledHarness live={updated} /> }],
      "/directory",
    );
    rerender(<RouterProvider router={router2} />);

    expect(screen.getByRole("link", { name: "@alice_renamed" })).toBeTruthy();
  });

  it("preserves the draft, disables Save, and warns on an identity-only external update while dirty, even though updatedAt is unchanged", () => {
    const alice = contact({ id: "alice", nickname: "Alice", username: "alice" });
    function ControlledHarness({ live }: { live: ThreadContact }) {
      return (
        <ContactEditDrawer
          ownerThreadsUserId="900"
          contactId="alice"
          liveContact={live}
          repository={new RecordingRepository()}
          clock={() => "2026-01-02T00:00:00.000Z"}
          onClose={vi.fn()}
        />
      );
    }
    const router = createTestRouter(
      [{ path: "/directory", element: <ControlledHarness live={alice} /> }],
      "/directory",
    );
    const { rerender } = render(<RouterProvider router={router} />);
    fireEvent.change(screen.getByLabelText(t("profile_nicknameLabel")), { target: { value: "My Draft" } });

    const updated = { ...alice, username: "alice_renamed", identityUpdatedAt: "2026-01-01T01:00:00.000Z" };
    const router2 = createTestRouter(
      [{ path: "/directory", element: <ControlledHarness live={updated} /> }],
      "/directory",
    );
    rerender(<RouterProvider router={router2} />);

    expect((screen.getByLabelText(t("profile_nicknameLabel")) as HTMLInputElement).value).toBe("My Draft");
    expect(screen.getByText(t("dashboard_drawer_externalUpdateWarning"))).toBeTruthy();
    expect((screen.getByRole("button", { name: t("profile_saveNickname") }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a deleted state and disables Save when the contact is removed elsewhere", () => {
    const alice = contact({ id: "alice", nickname: "Alice" });
    function ControlledHarness({ live }: { live: ThreadContact | null }) {
      return (
        <ContactEditDrawer
          ownerThreadsUserId="900"
          contactId="alice"
          liveContact={live}
          repository={new RecordingRepository()}
          clock={() => "2026-01-02T00:00:00.000Z"}
          onClose={vi.fn()}
        />
      );
    }
    const router = createTestRouter(
      [{ path: "/directory", element: <ControlledHarness live={alice} /> }],
      "/directory",
    );
    const { rerender } = render(<RouterProvider router={router} />);

    const router2 = createTestRouter(
      [{ path: "/directory", element: <ControlledHarness live={null} /> }],
      "/directory",
    );
    rerender(<RouterProvider router={router2} />);

    expect(screen.getByText(t("dashboard_drawer_deletedExternally"))).toBeTruthy();
    expect((screen.getByRole("button", { name: t("profile_saveNickname") }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: t("dashboard_drawer_deleteAction") }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("ContactEditDrawer: delete flow", () => {
  it("deletes only after confirmation, closes, and toasts success", async () => {
    const alice = contact({ id: "alice", nickname: "Alice" });
    const repository = new RecordingRepository();
    const success = vi.spyOn(toast, "success").mockReturnValue("toast-id");
    const { onClose } = renderDrawer({ contactId: "alice", liveContact: alice, repository });

    fireEvent.click(screen.getByRole("button", { name: t("dashboard_drawer_deleteAction") }));
    expect(repository.deleteCalls).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: t("profile_confirmDelete") }));
    await act(async () => {});

    expect(repository.deleteCalls).toEqual([{ id: "alice", now: "2026-01-02T00:00:00.000Z" }]);
    expect(success).toHaveBeenCalledWith(t("dashboard_drawer_deleteSuccess"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not delete when the confirmation is cancelled", () => {
    const alice = contact({ id: "alice", nickname: "Alice" });
    const repository = new RecordingRepository();
    const { onClose } = renderDrawer({ contactId: "alice", liveContact: alice, repository });

    fireEvent.click(screen.getByRole("button", { name: t("dashboard_drawer_deleteAction") }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: t("common_cancel") }));

    expect(repository.deleteCalls).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();
  });
});
