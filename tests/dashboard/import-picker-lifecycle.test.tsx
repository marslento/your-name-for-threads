import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { App } from "../../src/dashboard/App";
import { t } from "../../src/i18n/t";
import { __resetMigrationCoordinatorForTests } from "../../src/storage/migrations";
import { __resetDirectoryAccessQueueForTests } from "../../src/storage/directoryAccess";
import { confirmedAlice, dashboardStorage } from "../fixtures/dashboardHarness";
import { renderApp } from "../fixtures/renderApp";
import { installFakeChrome } from "../fixtures/storage/fakeChromeStorage";
import { ALICE, ALICE_DIR, AT } from "../fixtures/storage/recoveryStorage";

vi.mock("../../src/diagnostics/reportDiagnostic", () => ({ reportDiagnostic: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.pushState(null, "", "#/");
  Reflect.deleteProperty(globalThis, "chrome");
  __resetMigrationCoordinatorForTests();
  __resetDirectoryAccessQueueForTests();
});

// The original Phase 3.6 review delayed the real File.text() boundary.
// Keeping the parser and Dashboard real catches a late callback that navigates
// back into an import the user has already left.
it.each([false, true])("a delayed backup opens Preflight only while its picker is current (leave: %s)", async (leave) => {
  const storage = installFakeChrome(dashboardStorage(0));
  window.history.replaceState(null, "", "#/backup-sync");
  await renderApp(<App accountResolver={confirmedAlice} />);
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  expect(input).not.toBeNull();
  let finishRead!: (value: string) => void;
  const pendingRead = new Promise<string>((resolve) => { finishRead = resolve; });
  const readText = vi.fn(() => pendingRead);
  const file = Object.assign(new File([""], "backup.json", { type: "application/json" }), { text: readText });
  const before = storage.snapshot();
  const writesBefore = storage.writeCount();

  fireEvent.change(input, { target: { files: [file] } });
  expect(readText).toHaveBeenCalledOnce();
  if (leave) {
    fireEvent.click(screen.getByRole("link", { name: t("dashboard_sidebar_directory") }));
    await waitFor(() => expect(window.location.hash).toBe("#/directory"));
    expect(input.isConnected).toBe(false);
  }
  await act(async () => {
    finishRead(JSON.stringify({
      format: "threads-private-directory-backup",
      backupVersion: 2,
      exportedBy: { threadsUserId: ALICE, username: "alice" },
      directoryId: ALICE_DIR,
      exportedAt: AT,
      contacts: [],
      tombstones: [],
    }));
    await pendingRead;
  });

  if (leave) {
    expect(window.location.hash).toBe("#/directory");
    expect(screen.queryByRole("heading", { name: t("dashboard_import_preflightTitle") })).toBeNull();
  } else {
    expect(await screen.findByRole("heading", { name: t("dashboard_import_preflightTitle") })).toBeTruthy();
  }
  expect(storage.snapshot()).toEqual(before);
  expect(storage.writeCount()).toBe(writesBefore);
});
