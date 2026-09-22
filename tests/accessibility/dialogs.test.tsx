import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NicknameDialog } from "../../src/content/ui/profile/NicknameDialog";
import { t } from "../../src/i18n/t";
import { RecoveryPage } from "../../src/recovery/RecoveryPage";
import { closeDashboard, dashboardStorage, escape, openDashboard, press } from "../fixtures/dashboardHarness";
import { backgroundSendMessage } from "../fixtures/storage/diagnosticCoordinator";
import { installFakeChrome } from "../fixtures/storage/fakeChromeStorage";
import { ALICE } from "../fixtures/storage/recoveryStorage";

/**
 * Dialogs and drawers (Phase 4 Task 25; design summary section 23: dialog and sheet focus trap, sensible focus
 * restoration). Every dialog the Dashboard opens is controlled by state, with no trigger element, and Radix only
 * hands focus back to its own trigger, so without help a keyboard user who closes one lands on nothing and has to
 * tab from the top of the page again. Each case here presses the opener the way a keyboard user does (it takes
 * focus), and checks that focus goes into the dialog, stays there, and comes back to the opener.
 */
afterEach(closeDashboard);

describe("focus goes in, stays in, and comes back", () => {
  it("(control) the replayed tour in About & Privacy, which has a real trigger", async () => {
    await openDashboard("#/about");
    const opener = press(screen.getByRole("button", { name: t("dashboard_about_replayTour") }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog.contains(document.activeElement), "focus is inside").toBe(true);
    escape(dialog);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it("the confirmation before clearing an account's data on the Recovery page, cancelled", async () => {
    installFakeChrome(dashboardStorage(), backgroundSendMessage());
    render(<RecoveryPage state={{ kind: "directory", code: "DIRECTORY_INVALID" }} ownerThreadsUserId={ALICE} />);
    const opener = press(screen.getByRole("button", { name: t("dashboard_import_clearAccountAction") }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.contains(document.activeElement), "focus is inside").toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: t("common_cancel") }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it("the confirmation before clearing an account's data in Backup & Import, closed with Escape", async () => {
    await openDashboard("#/backup-sync");
    const opener = press(await screen.findByRole("button", { name: t("dashboard_import_clearAccountAction") }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.contains(document.activeElement), "focus is inside").toBe(true);
    escape(dialog);

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it("the contact editor drawer, opened from a row's button and closed with Escape", async () => {
    await openDashboard("#/directory");
    const opener = press((await screen.findAllByRole("button", { name: t("profile_editNickname") }))[0]);

    const drawer = await screen.findByRole("dialog");
    expect(drawer.contains(document.activeElement), "focus is inside").toBe(true);
    expect(opener.isConnected, "the row still has the button that was pressed: the table did not rebuild its buttons").toBe(true);
    escape(drawer);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it("the delete confirmation inside the contact editor, cancelled, returns to the Delete button, not to the page", async () => {
    await openDashboard("#/directory");
    press((await screen.findAllByRole("button", { name: t("profile_editNickname") }))[0]);
    await screen.findByRole("dialog");
    const opener = press(screen.getByRole("button", { name: t("dashboard_drawer_deleteAction") }));

    const confirm = await screen.findByRole("alertdialog");
    expect(confirm.contains(document.activeElement), "focus is inside the confirmation").toBe(true);
    fireEvent.click(within(confirm).getByRole("button", { name: t("common_cancel") }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
    expect(screen.getByRole("dialog"), "the drawer is still open behind it").toBeTruthy();
  });
});

describe("a dialog whose opener is inside a shadow root", () => {
  it("the nickname dialog on a Threads profile: the button is in the profile's root, the dialog in a second one, and focus still comes back", async () => {
    // The Profile UI is built like this on a Threads page: the button in one closed-off root, and dialogs portalled to another.
    const opening = document.body.appendChild(document.createElement("div")).attachShadow({ mode: "open" });
    const portalRoot = document.body.appendChild(document.createElement("div")).attachShadow({ mode: "open" });
    const buttonRoot = opening.appendChild(document.createElement("div"));
    const portal = portalRoot.appendChild(document.createElement("div"));
    function Profile() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            {t("profile_addNickname")}
          </button>
          <NicknameDialog open={open} mode="create" username="alice" initialNickname="" portalContainer={portal} onOpenChange={setOpen} onSave={vi.fn()} onSaveSuccess={vi.fn()} onSaveError={vi.fn()} />
        </>
      );
    }
    render(<Profile />, { container: buttonRoot });
    const opener = press(within(buttonRoot).getByRole("button", { name: t("profile_addNickname") }));

    const dialog = await within(portal).findByRole("dialog");
    expect(dialog.contains(portalRoot.activeElement), "focus is inside the dialog, in the other root").toBe(true);
    escape(dialog);

    await waitFor(() => expect(within(portal).queryByRole("dialog")).toBeNull());
    expect(opening.activeElement, "focus is back on the button in the profile's own root").toBe(opener);
  });
});

describe("what is behind an open dialog", () => {
  it("cannot take focus, and is hidden from a screen reader", async () => {
    installFakeChrome(dashboardStorage(), backgroundSendMessage());
    render(<RecoveryPage state={{ kind: "directory", code: "DIRECTORY_INVALID" }} ownerThreadsUserId={ALICE} />);
    const behind = screen.getByRole("button", { name: t("recovery_exportAction") });
    press(screen.getByRole("button", { name: t("dashboard_import_clearAccountAction") }));
    const dialog = await screen.findByRole("alertdialog");

    behind.focus();

    expect(dialog.contains(document.activeElement), "focus is pulled back inside").toBe(true);
    expect(behind.closest('[aria-hidden="true"]'), "the page behind is hidden from assistive technology").not.toBeNull();
  });
});

describe("the dialogs have names", () => {
  it.each([
    ["the contact editor", async () => {
      await openDashboard("#/directory");
      press((await screen.findAllByRole("button", { name: t("profile_editNickname") }))[0]);
      return screen.findByRole("dialog");
    }],
    ["the clear-data confirmation", async () => {
      await openDashboard("#/backup-sync");
      press(await screen.findByRole("button", { name: t("dashboard_import_clearAccountAction") }));
      return screen.findByRole("alertdialog");
    }],
  ])("%s says what it is and is described", async (_name, open) => {
    const dialog = await open();

    expect(dialog.getAttribute("aria-labelledby") ?? dialog.getAttribute("aria-label")).toBeTruthy();
    expect(within(dialog).queryAllByRole("heading").length + (dialog.getAttribute("aria-label") ? 1 : 0)).toBeGreaterThan(0);
  });
});
