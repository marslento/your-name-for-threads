import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DirectoryTable } from "../../src/dashboard/directory/DirectoryTable";
import type { ThreadContact } from "../../src/domain/contact";
import { t } from "../../src/i18n/t";

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

afterEach(() => {
  cleanup();
});

describe("DirectoryTable", () => {
  it("renders nickname, username link, note preview, and formatted updatedAt", () => {
    const alice = contact({
      id: "alice",
      username: "alice.b",
      nickname: "Alice",
      note: "Met at a conference",
      updatedAt: "2026-03-01T10:00:00.000Z",
    });
    render(
      <DirectoryTable
        contacts={[alice]}
        pendingConflictByContactId={new Map()}
        onEdit={vi.fn()}
        onResolveConflict={vi.fn()}
      />,
    );

    expect(screen.getByText("Alice")).toBeTruthy();
    expect(screen.getByText("Met at a conference")).toBeTruthy();
    const link = screen.getByRole("link", { name: "@alice.b" }) as HTMLAnchorElement;
    expect(link.href).toBe("https://www.threads.com/@alice.b");
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noopener");
  });

  it("keeps a long note whole and leaves the ellipsis to the column width", () => {
    const longNote = "a".repeat(90);
    const alice = contact({ id: "alice", note: longNote });
    render(
      <DirectoryTable
        contacts={[alice]}
        pendingConflictByContactId={new Map()}
        onEdit={vi.fn()}
        onResolveConflict={vi.fn()}
      />,
    );

    // No fixed character cut any more: the note is rendered in full and CSS
    // clips it to whatever the fixed 26% column is worth.
    const note = screen.getByText(longNote);
    expect(note.className).toContain("truncate");
  });

  it("pins the five columns to the agreed proportions, adding up to 100%", () => {
    const alice = contact({ id: "alice" });
    const { container } = render(
      <DirectoryTable
        contacts={[alice]}
        pendingConflictByContactId={new Map()}
        onEdit={vi.fn()}
        onResolveConflict={vi.fn()}
      />,
    );

    const widths = [...container.querySelectorAll("col")].map((col) => (col as HTMLElement).style.width);
    expect(widths).toEqual(["24%", "20%", "26%", "20%", "10%"]);
    expect(widths.reduce((total, width) => total + Number.parseInt(width, 10), 0)).toBe(100);
    expect(container.querySelector("table")!.className).toContain("table-fixed");
  });

  it("shows only the Edit action for a normal contact", () => {
    const alice = contact({ id: "alice" });
    render(
      <DirectoryTable
        contacts={[alice]}
        pendingConflictByContactId={new Map()}
        onEdit={vi.fn()}
        onResolveConflict={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: t("profile_editNickname") })).toBeTruthy();
    expect(screen.queryByRole("button", { name: t("dashboard_directory_resolveConflictAction") })).toBeNull();
    expect(screen.queryByText(t("profile_pendingConfirmation"))).toBeNull();
  });

  it("shows the pending badge and both actions for a canonical conflicted contact", () => {
    const alice = contact({ id: "alice", threadsUserId: "123" });
    render(
      <DirectoryTable
        contacts={[alice]}
        pendingConflictByContactId={new Map([["alice", "conflict-1"]])}
        onEdit={vi.fn()}
        onResolveConflict={vi.fn()}
      />,
    );

    expect(screen.getByText(t("profile_pendingConfirmation"))).toBeTruthy();
    expect(screen.getByRole("button", { name: t("profile_editNickname") })).toBeTruthy();
    expect(screen.getByRole("button", { name: t("dashboard_directory_resolveConflictAction") })).toBeTruthy();
  });

  it("calls onEdit with the row's contact and onResolveConflict with the conflict id", () => {
    const alice = contact({ id: "alice", threadsUserId: "123" });
    const onEdit = vi.fn();
    const onResolveConflict = vi.fn();
    render(
      <DirectoryTable
        contacts={[alice]}
        pendingConflictByContactId={new Map([["alice", "conflict-1"]])}
        onEdit={onEdit}
        onResolveConflict={onResolveConflict}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: t("profile_editNickname") }));
    expect(onEdit).toHaveBeenCalledWith(alice);

    fireEvent.click(screen.getByRole("button", { name: t("dashboard_directory_resolveConflictAction") }));
    expect(onResolveConflict).toHaveBeenCalledWith("conflict-1");
  });

  it("does not render a clickable row or any avatar image", () => {
    const alice = contact({ id: "alice" });
    const onEdit = vi.fn();
    render(
      <DirectoryTable
        contacts={[alice]}
        pendingConflictByContactId={new Map()}
        onEdit={onEdit}
        onResolveConflict={vi.fn()}
      />,
    );

    const row = screen.getAllByRole("row")[1];
    expect(within(row).queryByRole("img")).toBeNull();
    fireEvent.click(row);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("uses contact.id as the row key so identical nicknames don't collide", () => {
    const alice = contact({ id: "alice-1", nickname: "Sam" });
    const bob = contact({ id: "alice-2", nickname: "Sam" });
    render(
      <DirectoryTable
        contacts={[alice, bob]}
        pendingConflictByContactId={new Map()}
        onEdit={vi.fn()}
        onResolveConflict={vi.fn()}
      />,
    );

    expect(screen.getAllByText("Sam")).toHaveLength(2);
  });
});
