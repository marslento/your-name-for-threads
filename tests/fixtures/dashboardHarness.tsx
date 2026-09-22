import { cleanup, fireEvent } from "@testing-library/react";
import { vi } from "vitest";

import type { CurrentAccountResolver } from "../../src/account/CurrentAccountResolver";
import { App as Dashboard } from "../../src/dashboard/App";
import { __resetDiagnosticReportsForTests } from "../../src/diagnostics/reportDiagnostic";
import { __resetMigrationCoordinatorForTests } from "../../src/storage/migrations";
import { renderApp } from "./renderApp";
import { backgroundSendMessage } from "./storage/diagnosticCoordinator";
import { installFakeChrome } from "./storage/fakeChromeStorage";
import { ALICE, ALICE_DIR, AT, directory, twoAccounts } from "./storage/recoveryStorage";

/**
 * The whole Dashboard, for the account Alice with a few contacts, over a fake storage: what the accessibility
 * tests (tests/accessibility) all start from. `openDashboard` returns once the account check has finished, which
 * is not the same as the page having loaded its own controls, so a test still waits for the one it needs.
 */
const PEOPLE = [
  ["c1", "carol", "阿明"],
  ["c2", "dave", "小華"],
  ["c3", "erin", "Erin"],
] as const;

export const dashboardStorage = (people = 1) =>
  twoAccounts({
    directories: {
      [ALICE_DIR]: directory(ALICE_DIR, {
        contacts: Object.fromEntries(PEOPLE.slice(0, people).map(([id, username, nickname]) => [id, { id, username, nickname, createdAt: AT, updatedAt: AT, identityUpdatedAt: AT }])),
        identityIndex: Object.fromEntries(PEOPLE.slice(0, people).map(([id, username]) => [`username:${username}`, id])),
      }),
    },
    accountBindings: { [ALICE]: ALICE_DIR },
    onboarding: { completed: true },
  });

export const confirmedAlice: CurrentAccountResolver = {
  getState: () => ({ state: "confirmed", ownerThreadsUserId: ALICE, ownerUsername: "alice" }),
  subscribe: () => () => {},
};

export async function openDashboard(hash: string, people = 1) {
  window.location.hash = hash;
  installFakeChrome(dashboardStorage(people), backgroundSendMessage());
  return renderApp(<Dashboard accountResolver={confirmedAlice} />);
}

/** What a keyboard user does: the control has focus, and Enter or Space presses it. */
export function press(button: HTMLElement) {
  button.focus();
  fireEvent.click(button);
  return button;
}

export const escape = (target: Element) => fireEvent.keyDown(target, { key: "Escape" });

/** For `afterEach`: unmounts, drains what the Dashboard's store still has in flight, and resets the module state the tests share. */
export async function closeDashboard() {
  cleanup();
  vi.restoreAllMocks();
  window.location.hash = "";
  await new Promise((resolve) => setTimeout(resolve, 0));
  Reflect.deleteProperty(globalThis, "chrome");
  __resetMigrationCoordinatorForTests();
  __resetDiagnosticReportsForTests();
}
