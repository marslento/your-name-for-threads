import { act } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ThreadContact } from "../../src/domain/contact";
import type { ThreadsIdentity } from "../../src/domain/identity";
import { normalizeUsername } from "../../src/domain/validation";
import { ProfileNicknameApp } from "../../src/content/ui/profile/ProfileNicknameApp";
import { t } from "../../src/i18n/t";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const identity: ThreadsIdentity = { username: "alice", threadsUserId: "123" };
const contact: ThreadContact = {
  id: "alice-id",
  username: "alice",
  threadsUserId: "123",
  nickname: "攝影師阿明",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  identityUpdatedAt: "2026-01-01T00:00:00.000Z",
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ProfileNicknameApp", () => {
  it("renders one add button and forwards the current identity when no active contact resolves", () => {
    const onCreate = vi.fn();

    render(
      <ProfileNicknameApp
        resolver={{ resolve: () => null }}
        identity={identity}
        onCreate={onCreate}
        onEdit={vi.fn()}
      />,
    );

    const addButton = screen.getByRole("button", { name: t("profile_addNickname") });
    expect(screen.getAllByRole("button")).toEqual([addButton]);
    fireEvent.click(addButton);
    expect(onCreate).toHaveBeenCalledWith(identity);
  });

  it("renders only a static nickname and one edit control for the resolved active contact", () => {
    const resolve = vi.fn(() => contact);
    const onCreate = vi.fn();
    const onEdit = vi.fn();

    render(
      <ProfileNicknameApp
        resolver={{ resolve }}
        identity={identity}
        onCreate={onCreate}
        onEdit={onEdit}
      />,
    );

    const nickname = screen.getByText(contact.nickname);
    const editButton = screen.getByRole("button", { name: t("profile_editNickname") });
    expect(resolve).toHaveBeenCalledWith(identity);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: t("profile_addNickname") })).toBeNull();
    expect(nickname.closest("button, a")).toBeNull();
    expect(editButton.contains(nickname)).toBe(false);
    fireEvent.click(editButton);
    expect(onEdit).toHaveBeenCalledWith(contact);
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("shows a static pending-conflict warning only when the explicit signal is pending", () => {
    const { rerender } = render(
      <ProfileNicknameApp
        resolver={{ resolve: () => contact }}
        identity={identity}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
        hasPendingConflict
      />,
    );

    const warning = screen.getByText(t("profile_pendingConfirmation"));
    expect(warning.closest("button, a")).toBeNull();
    expect(warning.getAttribute("title")).toBe(t("profile_pendingConflictDescription"));
    expect(screen.getAllByRole("button")).toHaveLength(1);

    rerender(
      <ProfileNicknameApp
        resolver={{ resolve: () => contact }}
        identity={identity}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
        hasPendingConflict={false}
      />,
    );

    expect(screen.queryByText(t("profile_pendingConfirmation"))).toBeNull();
    rerender(
      <ProfileNicknameApp
        resolver={{ resolve: () => contact }}
        identity={identity}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
      />,
    );
    expect(screen.queryByText(t("profile_pendingConfirmation"))).toBeNull();
  });

  it("hides blank resolved contact data", () => {
    const unsafeContact = { ...contact, nickname: "   " };
    render(
      <ProfileNicknameApp
        resolver={{ resolve: () => unsafeContact }}
        identity={identity}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
        hasPendingConflict
      />,
    );

    expect(screen.getByRole("button", { name: t("profile_addNickname") })).toBeTruthy();
    expect(screen.queryByText(contact.nickname)).toBeNull();
    expect(screen.queryByText(t("profile_pendingConfirmation"))).toBeNull();
  });

  it("delegates a case-variant identity to the resolver without normalizing it", () => {
    const caseVariantIdentity: ThreadsIdentity = { username: " @ALICE ", threadsUserId: "123" };
    const resolve = vi.fn((value: ThreadsIdentity) =>
      normalizeUsername(value.username) === "alice" ? contact : null,
    );
    render(
      <ProfileNicknameApp
        resolver={{ resolve }}
        identity={caseVariantIdentity}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    expect(screen.getByText(contact.nickname)).toBeTruthy();
    expect(resolve).toHaveBeenCalledWith(caseVariantIdentity);
    expect(caseVariantIdentity).toEqual({ username: " @ALICE ", threadsUserId: "123" });
  });

  it("does not mutate a frozen identity before forwarding it to create", () => {
    const frozenIdentity = Object.freeze({ ...identity });
    const onCreate = vi.fn();

    render(
      <ProfileNicknameApp
        resolver={{ resolve: () => null }}
        identity={frozenIdentity}
        onCreate={onCreate}
        onEdit={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: t("profile_addNickname") }));
    expect(onCreate.mock.calls[0]?.[0]).toBe(frozenIdentity);
    expect(frozenIdentity).toEqual(identity);
  });

  it("does not mutate a frozen contact before forwarding it to edit", () => {
    const frozenContact = Object.freeze({ ...contact });
    const onEdit = vi.fn();

    render(
      <ProfileNicknameApp
        resolver={{ resolve: () => frozenContact }}
        identity={identity}
        onCreate={vi.fn()}
        onEdit={onEdit}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: t("profile_editNickname") }));
    expect(onEdit.mock.calls[0]?.[0]).toBe(frozenContact);
    expect(frozenContact.nickname).toBe(contact.nickname);
  });

  it("renders a current resolver result after a parent rerender", () => {
    let resolvedContact: ThreadContact | null = null;
    const resolver = { resolve: () => resolvedContact };
    const onCreate = vi.fn();
    const onEdit = vi.fn();
    const { rerender } = render(
      <ProfileNicknameApp resolver={resolver} identity={identity} onCreate={onCreate} onEdit={onEdit} />,
    );

    expect(screen.getByRole("button", { name: t("profile_addNickname") })).toBeTruthy();
    act(() => {
      resolvedContact = contact;
      rerender(
        <ProfileNicknameApp resolver={resolver} identity={identity} onCreate={onCreate} onEdit={onEdit} />,
      );
    });

    expect(screen.getByText(contact.nickname)).toBeTruthy();
    expect(screen.getByRole("button", { name: t("profile_editNickname") })).toBeTruthy();
  });

  it("keeps a long nickname within a shrinkable wrapping text region", () => {
    const longNickname = "很長的暱稱".repeat(20);
    const longContact = { ...contact, nickname: longNickname };

    render(
      <ProfileNicknameApp
        resolver={{ resolve: () => longContact }}
        identity={identity}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    const nickname = screen.getByText(longNickname);
    expect(nickname.classList.contains("min-w-0")).toBe(true);
    expect(nickname.classList.contains("break-words")).toBe(true);
  });
});
