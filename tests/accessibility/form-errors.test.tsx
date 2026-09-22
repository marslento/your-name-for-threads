import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NicknameDialog } from "../../src/content/ui/profile/NicknameDialog";
import { MAX_NICKNAME_LENGTH, MAX_NOTE_LENGTH } from "../../src/domain/validation";
import { t } from "../../src/i18n/t";
import { closeDashboard, openDashboard, press } from "../fixtures/dashboardHarness";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * An error is connected to the control it is about (Phase 4 Task 25; design summary section 23: "error is associated
 * with the input"). A control that is invalid says so (`aria-invalid`) and points at the words that say why
 * (`aria-describedby`), and those words are in a live region so the change is announced as the person types.
 * The import review's editor has its own tests (tests/dashboard/final-contact-editor.test.tsx); these are the
 * contact editor in the Dashboard and the nickname dialog on a Threads profile.
 */
afterEach(async () => {
  await closeDashboard();
  cleanup();
});

/** What a screen reader gets for a control: whether it is invalid, and the text it is described by. */
function describedError(control: HTMLElement) {
  const ids = (control.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
  const targets = ids.map((id) => document.getElementById(id));
  return {
    invalid: control.getAttribute("aria-invalid"),
    message: targets.map((target) => target?.textContent ?? "").join(" ").trim(),
    live: targets.some((target) => target?.getAttribute("aria-live") === "polite" || target?.closest("[aria-live]") !== null),
    dangling: targets.some((target) => target === null),
  };
}

async function openEditor() {
  await openDashboard("#/directory");
  press((await screen.findAllByRole("button", { name: t("profile_editNickname") }))[0]);
  await screen.findByRole("dialog");
}

describe("the contact editor in the Dashboard", () => {
  it("names the problem with the nickname, in a live region, and stops when it is fixed", async () => {
    await openEditor();
    const nickname = screen.getByLabelText(t("profile_nicknameLabel"));

    fireEvent.change(nickname, { target: { value: "" } });
    expect(describedError(nickname)).toEqual({ invalid: "true", message: t("profile_nicknameInvalid"), live: true, dangling: false });

    fireEvent.change(nickname, { target: { value: "Alice" } });
    expect(describedError(nickname)).toMatchObject({ invalid: "false", message: "" });
    expect(nickname.getAttribute("aria-describedby")).toBeNull();
  });

  it("names the problem with the note, in a live region, and stops when it is fixed", async () => {
    await openEditor();
    const note = screen.getByLabelText(t("dashboard_drawer_noteLabel"));

    fireEvent.change(note, { target: { value: "x".repeat(MAX_NOTE_LENGTH + 1) } });
    expect(describedError(note)).toEqual({ invalid: "true", message: t("dashboard_drawer_noteInvalid"), live: true, dangling: false });

    fireEvent.change(note, { target: { value: "a short note" } });
    expect(describedError(note)).toMatchObject({ invalid: "false", message: "" });
    expect(note.getAttribute("aria-describedby")).toBeNull();
  });

  it("(control) starts with neither field invalid", async () => {
    await openEditor();

    for (const control of [screen.getByLabelText(t("profile_nicknameLabel")), screen.getByLabelText(t("dashboard_drawer_noteLabel"))]) {
      expect(describedError(control)).toMatchObject({ invalid: "false", message: "" });
    }
  });
});

describe("the nickname dialog on a Threads profile", () => {
  it("names the problem with an over-long nickname, and it clears when it is fixed", () => {
    render(<NicknameDialog open mode="create" username="alice" initialNickname="" portalContainer={document.body} onOpenChange={vi.fn()} onSave={vi.fn()} onSaveSuccess={vi.fn()} onSaveError={vi.fn()} />);
    const input = screen.getByLabelText(t("profile_nicknameLabel"));

    act(() => void fireEvent.change(input, { target: { value: "x".repeat(MAX_NICKNAME_LENGTH + 1) } }));
    const invalid = describedError(input);
    expect(invalid.invalid).toBe("true");
    expect(invalid.message).not.toBe("");
    expect(invalid.dangling).toBe(false);

    act(() => void fireEvent.change(input, { target: { value: "Alice" } }));
    expect(describedError(input)).toMatchObject({ invalid: "false", message: "" });
  });
});
