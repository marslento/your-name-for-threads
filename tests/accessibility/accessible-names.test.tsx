import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NicknameDialog } from "../../src/content/ui/profile/NicknameDialog";
import { DeleteNicknameDialog } from "../../src/content/ui/profile/DeleteNicknameDialog";
import { t } from "../../src/i18n/t";
import { DirectoryTable } from "../../src/dashboard/directory/DirectoryTable";
import { App as Popup } from "../../src/popup/App";
import { RecoveryPage } from "../../src/recovery/RecoveryPage";
import { TAB_SURFACES_STORAGE_KEY } from "../../src/shared/tabSurfaces";
import { closeDashboard, openDashboard } from "../fixtures/dashboardHarness";
import { backgroundSendMessage } from "../fixtures/storage/diagnosticCoordinator";
import { installFakeChrome } from "../fixtures/storage/fakeChromeStorage";
import { installFakeChromeWithSession } from "../fixtures/storage/fakeChromeWithSession";
import { ALICE, twoAccounts } from "../fixtures/storage/recoveryStorage";

/**
 * Every control has an accessible name (Phase 4 Task 25; design summary section 23: "icon button has an accessible
 * name", accessible names for the Popup, the Dashboard, Import and Recovery). "Named" is what a screen reader
 * announces, worked out by the same routine Testing Library uses to find a control by its name, so a control that has
 * an icon and no label, or a field with no label, is caught here whatever markup produced it. Each screen also
 * has to have some controls, so an audit of an empty page cannot pass.
 */
const CONTROLS = ["button", "link", "textbox", "searchbox", "checkbox", "switch", "combobox", "radio", "tab", "menuitem", "option", "slider", "spinbutton"] as const;

function inventory(root: HTMLElement = document.body) {
  const unnamed: string[] = [];
  let total = 0;
  for (const role of CONTROLS) {
    const named = new Set(within(root).queryAllByRole(role, { name: /\S/ }));
    for (const element of within(root).queryAllByRole(role)) {
      total += 1;
      if (!named.has(element)) unnamed.push(`${role}: ${element.outerHTML.slice(0, 140)}`);
    }
  }
  return { total, unnamed };
}

const expectNamed = (minimum: number, root?: HTMLElement) => {
  const { total, unnamed } = inventory(root);
  expect(total, "the screen has controls to audit").toBeGreaterThanOrEqual(minimum);
  expect(unnamed).toEqual([]);
};

afterEach(closeDashboard);

describe("the popup", () => {
  const popup = (options: { tab: { id: number; url: string }; registry?: Record<string, unknown>; onboarded?: boolean }) => {
    installFakeChromeWithSession(
      options.onboarded === false ? twoAccounts() : { ...twoAccounts(), onboarding: { completed: true } },
      options.registry ? { [TAB_SURFACES_STORAGE_KEY]: options.registry } : {},
      { tabs: { query: async () => [options.tab] }, runtime: { sendMessage: backgroundSendMessage(), getURL: (path: string) => `chrome-extension://test/${path}` } },
    );
    return render(<Popup />);
  };

  it("on a page that is not Threads", async () => {
    popup({ tab: { id: 1, url: "https://example.com/" } });
    await screen.findByRole("button", { name: t("popup_openDashboard") });

    expectNamed(2);
  });

  it("on Threads, with the partial-integration notice up", async () => {
    popup({ tab: { id: 7, url: "https://www.threads.com/@someone" }, registry: { "7": { profile: "degraded", "post-author": "ready" } } });
    await screen.findByText(t("integration_partialUnavailable"));

    expectNamed(3); // Open Directory, the switch, and the report link
  });

  it("as the first-run tour", async () => {
    popup({ tab: { id: 1, url: "https://example.com/" }, onboarded: false });
    await screen.findByRole("heading", { level: 2 });

    expectNamed(1);
  });
});

describe("the Dashboard", () => {
  // What each route shows once it has loaded, so an audit cannot be run on a page that is still empty.
  it.each([
    ["the Directory, with contacts", "#/directory", () => screen.findAllByText("阿明"), 8],
    ["Settings", "#/settings", () => screen.findAllByRole("switch"), 4],
    ["Backup & Import", "#/backup-sync", () => screen.findByRole("button", { name: t("dashboard_import_clearAccountAction") }), 4],
    ["the import chooser", "#/backup-sync/import", () => screen.findByRole("heading", { name: t("dashboard_import_homeTitle") }), 1],
    ["Conflicts", "#/conflicts", () => screen.findByRole("heading", { name: t("dashboard_conflicts_title") }), 1],
    ["About & Privacy", "#/about", () => screen.findByRole("button", { name: t("dashboard_about_copyDiagnostics") }), 6],
  ])("%s", async (_name, hash, loaded, minimum) => {
    await openDashboard(hash, 3);
    await loaded();

    expectNamed(minimum);
  });

  it("the contact editor, once it is open", async () => {
    await openDashboard("#/directory");
    fireEvent.click((await screen.findAllByRole("button", { name: t("profile_editNickname") }))[0]);
    await screen.findByRole("dialog");

    expectNamed(3);
  });

  it("the replayed tour dialog in About & Privacy", async () => {
    await openDashboard("#/about");
    fireEvent.click(screen.getByRole("button", { name: t("dashboard_about_replayTour") }));
    await screen.findByRole("dialog");

    expectNamed(2);
  });
});

describe("Recovery", () => {
  const recovery = (state: Parameters<typeof RecoveryPage>[0]["state"]) => {
    installFakeChrome(twoAccounts(), backgroundSendMessage());
    return render(<RecoveryPage state={state} ownerThreadsUserId={ALICE} />);
  };

  it.each([
    ["one damaged account", { kind: "directory", code: "DIRECTORY_INVALID" } as const, 4],
    ["all data", { kind: "global", code: "STORAGE_INVALID" } as const, 3],
  ])("the Recovery page for %s", (_name, state, minimum) => {
    recovery(state);

    expectNamed(minimum);
  });

  it("the confirmation before clearing an account's data", async () => {
    recovery({ kind: "directory", code: "DIRECTORY_INVALID" });
    fireEvent.click(screen.getByRole("button", { name: t("dashboard_import_clearAccountAction") }));
    await screen.findByRole("alertdialog");

    expectNamed(2);
  });
});

describe("the nickname dialogs on a Threads profile", () => {
  it("create and edit", () => {
    render(<NicknameDialog open mode="edit" username="alice" initialNickname="阿明" portalContainer={document.body} onOpenChange={vi.fn()} onSave={vi.fn()} onSaveSuccess={vi.fn()} onSaveError={vi.fn()} onDelete={vi.fn()} />);

    expectNamed(3);
  });

  it("delete confirmation", () => {
    render(<DeleteNicknameDialog open sessionKey="alice" portalContainer={document.body} onOpenChange={vi.fn()} onDelete={vi.fn()} onDeleteSuccess={vi.fn()} onDeleteError={vi.fn()} />);

    expectNamed(2);
  });
});

describe("a row's buttons say whose they are", () => {
  const described = (button: HTMLElement) => document.getElementById(button.getAttribute("aria-describedby") ?? "")?.textContent;

  it("in the Directory, each Edit button is described by its own row's nickname, and its name is unchanged", async () => {
    await openDashboard("#/directory", 3);
    await screen.findAllByText("阿明");

    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const edit = within(row).getByRole("button", { name: t("profile_editNickname") });
      expect(described(edit)).toBe(within(row).getAllByRole("cell")[0].textContent);
    }
    expect(new Set(rows.map((row) => described(within(row).getByRole("button", { name: t("profile_editNickname") })))).size, "three different descriptions").toBe(3);
  });

  it("and so is the button that resolves a conflict", () => {
    const contact = { id: "c1", username: "carol", nickname: "阿明", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", identityUpdatedAt: "2026-01-01T00:00:00.000Z" };
    render(<DirectoryTable contacts={[contact]} pendingConflictByContactId={new Map([["c1", "k1"]])} onEdit={vi.fn()} onResolveConflict={vi.fn()} />);

    expect(described(screen.getByRole("button", { name: t("dashboard_directory_resolveConflictAction") }))).toBe("阿明");
  });
});

describe("the audit itself", () => {
  it("(control) does find a button with only an icon, and a field with no label", () => {
    render(
      <main>
        <button type="button">
          <svg aria-hidden="true" />
        </button>
        <input type="text" />
        <button type="button">Named</button>
      </main>,
    );

    const { total, unnamed } = inventory();

    expect(total).toBe(3);
    expect(unnamed).toHaveLength(2);
  });
});
