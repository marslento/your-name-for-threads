import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { t } from "../../src/i18n/t";
import { RecoveryPage, type RecoveryPageProps } from "../../src/recovery/RecoveryPage";
import { GITHUB_BUG_REPORT_URL } from "../../src/shared/links";
import { installFakeChrome } from "../fixtures/storage/fakeChromeStorage";
import { ALICE, ALICE_DIR, DAMAGED_ALICE, withDirectory } from "../fixtures/storage/recoveryStorage";

/**
 * The Recovery page (Phase 4 Task 19, checklist #14-#18). What it offers is as much the point as how it
 * looks: keep a raw copy, copy diagnostics, report, and for one damaged account clear it. Never repair,
 * rebuild an index, or import a recovery file.
 */
const DIRECTORY = { kind: "directory", code: "DIRECTORY_INVALID" } as const;
const GLOBAL = { kind: "global", code: "COLLECTION_INVALID" } as const;

let success: ReturnType<typeof vi.spyOn>;
let failure: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  success = vi.spyOn(toast, "success").mockReturnValue("toast");
  failure = vi.spyOn(toast, "error").mockReturnValue("toast");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "clipboard");
  Reflect.deleteProperty(globalThis, "chrome");
});

function renderPage(overrides: Partial<RecoveryPageProps> = {}) {
  const props: RecoveryPageProps = {
    state: DIRECTORY,
    ownerThreadsUserId: ALICE,
    exportRecovery: vi.fn(async () => true),
    clearDamagedDirectory: vi.fn(async () => ({ ok: true }) as const),
    ...overrides,
  };
  render(<RecoveryPage {...props} />);
  return props;
}

const button = (key: string) => screen.getByRole("button", { name: t(key) });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

describe("RecoveryPage: what it says", () => {
  it("for one damaged account: pauses that account only, names the code, and warns about what a recovery file holds", () => {
    renderPage();

    expect(screen.getByRole("heading", { level: 1, name: t("recovery_title") })).toBeTruthy();
    expect(screen.getByText(t("recovery_descriptionDirectory"))).toBeTruthy();
    expect(screen.getByText(t("recovery_exportWarningDirectory"))).toBeTruthy();
    expect(screen.getByText("DIRECTORY_INVALID")).toBeTruthy();
    expect(screen.getByText(t("recovery_noRepair"))).toBeTruthy();
  });

  it("for damage to everything: says every account is paused, and that the recovery file holds every account's data", () => {
    renderPage({ state: GLOBAL });

    expect(screen.getByText(t("recovery_descriptionGlobal"))).toBeTruthy();
    expect(screen.getByText(t("recovery_exportWarningGlobal"))).toBeTruthy();
    expect(t("recovery_exportWarningGlobal")).toMatch(/every account/i);
    expect(screen.getByText("COLLECTION_INVALID")).toBeTruthy();
  });

  it("shows no username, nickname, note or ID: only a scope and a code", () => {
    renderPage();

    expect(document.body.textContent).not.toMatch(new RegExp(`${ALICE}|@|PRIVATE_|${ALICE_DIR}`));
  });
});

describe("RecoveryPage: what it offers", () => {
  it("offers a raw export, diagnostics, a report and a clear, and nothing that repairs, rebuilds or imports", () => {
    renderPage();

    const buttons = screen.getAllByRole("button").map((b) => b.textContent);
    expect(buttons).toEqual([t("recovery_exportAction"), t("dashboard_about_copyDiagnostics"), t("dashboard_import_clearAccountAction")]);
    expect(screen.getAllByRole("link")).toHaveLength(1);
    // No control anywhere, in any of the three languages, that repairs, rebuilds or imports.
    expect(document.body.textContent).not.toMatch(/repair button|rebuild|reimport|re-import|import recovery/i);
    expect(document.querySelector("input[type=file]")).toBeNull();
  });

  it("links to the bug report form and to nothing else, without opener or referrer, and puts no diagnostics in the address", () => {
    renderPage();

    const report = screen.getByRole("link", { name: t("dashboard_about_reportIssue") });
    expect(report.getAttribute("href")).toBe(GITHUB_BUG_REPORT_URL);
    expect(report.getAttribute("target")).toBe("_blank");
    expect(report.getAttribute("rel")).toBe("noopener noreferrer");
    expect(new URL(report.getAttribute("href")!).search).toBe("?template=bug_report.yml");
  });

  it("offers no clear at all when everything is damaged, and says why", () => {
    renderPage({ state: GLOBAL });

    expect(screen.queryByRole("button", { name: t("dashboard_import_clearAccountAction") })).toBeNull();
    expect(screen.getByText(t("recovery_globalNoClear"))).toBeTruthy();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([t("recovery_exportAction"), t("dashboard_about_copyDiagnostics")]);
  });
});

describe("RecoveryPage: exporting", () => {
  it("exports for the account, and says it worked", async () => {
    const props = renderPage();

    fireEvent.click(button("recovery_exportAction"));

    await waitFor(() => expect(success).toHaveBeenCalledWith(t("recovery_exportSuccess")));
    expect(props.exportRecovery).toHaveBeenCalledExactlyOnceWith(ALICE);
  });

  it.each([
    ["nothing to export or the save failed", () => Promise.resolve(false)],
    ["the export throws", () => Promise.reject(new Error("boom"))],
  ])("says so when %s", async (_name, exportRecovery) => {
    renderPage({ exportRecovery });

    fireEvent.click(button("recovery_exportAction"));

    await waitFor(() => expect(failure).toHaveBeenCalledWith(t("recovery_exportError")));
    expect(success).not.toHaveBeenCalled();
  });

  it("cannot be started twice while it is running", async () => {
    const pending = deferred<boolean>();
    const props = renderPage({ exportRecovery: vi.fn(() => pending.promise) });

    fireEvent.click(button("recovery_exportAction"));
    await waitFor(() => expect((button("recovery_exportAction") as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(button("recovery_exportAction"));

    expect(props.exportRecovery).toHaveBeenCalledTimes(1);
    pending.resolve(true);
    await waitFor(() => expect(success).toHaveBeenCalled());
  });
});

describe("RecoveryPage: diagnostics", () => {
  it("copies diagnostics that name the Recovery state and carry none of the damaged data", async () => {
    installFakeChrome(withDirectory(ALICE_DIR, DAMAGED_ALICE));
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    renderPage();

    fireEvent.click(button("dashboard_about_copyDiagnostics"));

    await waitFor(() => expect(success).toHaveBeenCalledWith(t("dashboard_about_copySuccess")));
    const copied = String((writeText.mock.calls as unknown as string[][])[0][0]);
    expect(copied).toContain("Recovery state: directory (DIRECTORY_INVALID)");
    expect(copied).not.toMatch(/PRIVATE_|dir-alice|not-the-key/);
  });

  it("says so when the clipboard refuses", async () => {
    installFakeChrome(withDirectory(ALICE_DIR, DAMAGED_ALICE));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(() => Promise.reject(new Error("denied"))) } });
    renderPage();

    fireEvent.click(button("dashboard_about_copyDiagnostics"));

    await waitFor(() => expect(failure).toHaveBeenCalledWith(t("dashboard_about_copyError")));
  });
});

describe("RecoveryPage: clearing the account's data", () => {
  async function openConfirm() {
    fireEvent.click(button("dashboard_import_clearAccountAction"));
    return within(await screen.findByRole("alertdialog"));
  }

  it("asks first, says it cannot be undone, and does nothing until it is confirmed", async () => {
    const props = renderPage();

    const dialog = await openConfirm();

    expect(dialog.getByText(t("recovery_clearConfirmTitle"))).toBeTruthy();
    expect(dialog.getByText(t("recovery_clearConfirmDescription"))).toBeTruthy();
    expect(props.clearDamagedDirectory).not.toHaveBeenCalled();
  });

  it("does nothing when it is cancelled", async () => {
    const props = renderPage();
    const dialog = await openConfirm();

    fireEvent.click(dialog.getByRole("button", { name: t("common_cancel") }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(props.clearDamagedDirectory).not.toHaveBeenCalled();
  });

  it("clears the account's own data once confirmed, then closes, says so, and lets the Dashboard carry on", async () => {
    const onCleared = vi.fn();
    const props = renderPage({ onCleared });
    const dialog = await openConfirm();

    fireEvent.click(dialog.getByRole("button", { name: t("dashboard_import_clearAccountAction") }));

    await waitFor(() => expect(success).toHaveBeenCalledWith(t("dashboard_import_clearAccountSuccess")));
    expect(props.clearDamagedDirectory).toHaveBeenCalledExactlyOnceWith(ALICE);
    expect(onCleared).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it.each([
    ["refuses", () => Promise.resolve({ ok: false, reason: "not_in_recovery" }) as never],
    ["throws", () => Promise.reject(new Error("boom"))],
  ])("says so and does not carry on when the clear %s", async (_name, clearDamagedDirectory) => {
    const onCleared = vi.fn();
    renderPage({ clearDamagedDirectory, onCleared });
    const dialog = await openConfirm();

    fireEvent.click(dialog.getByRole("button", { name: t("dashboard_import_clearAccountAction") }));

    await waitFor(() => expect(failure).toHaveBeenCalledWith(t("dashboard_import_clearAccountError")));
    expect(success).not.toHaveBeenCalled();
    expect(onCleared).not.toHaveBeenCalled();
  });

  it("cannot be confirmed twice, or cancelled, while it is running", async () => {
    const pending = deferred<{ ok: true }>();
    const props = renderPage({ clearDamagedDirectory: vi.fn(() => pending.promise as never) });
    const dialog = await openConfirm();

    fireEvent.click(dialog.getByRole("button", { name: t("dashboard_import_clearAccountAction") }));
    await waitFor(() => expect((dialog.getByRole("button", { name: t("common_cancel") }) as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(dialog.getByRole("button", { name: t("dashboard_import_clearAccountAction") }));

    expect(props.clearDamagedDirectory).toHaveBeenCalledTimes(1);
    pending.resolve({ ok: true });
    await waitFor(() => expect(success).toHaveBeenCalled());
  });
});
