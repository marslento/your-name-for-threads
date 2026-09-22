import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { t } from "../../src/i18n/t";
import { RecoveryPage } from "../../src/recovery/RecoveryPage";
import { closeDashboard, dashboardStorage, openDashboard } from "../fixtures/dashboardHarness";
import { backgroundSendMessage } from "../fixtures/storage/diagnosticCoordinator";
import { installFakeChrome } from "../fixtures/storage/fakeChromeStorage";
import { ALICE } from "../fixtures/storage/recoveryStorage";

/**
 * What happens without being asked for is announced (Phase 4 Task 25; the baseline listed "toast announcement" on the
 * Recovery page as owed). A toast is a message that appears and goes; a person who cannot see it hears it only if it
 * is inside a live region. Both the Dashboard and the Recovery page, which replaces it and mounts its own toaster,
 * are checked, for what worked and for what did not.
 */
let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});

afterEach(async () => {
  await closeDashboard();
  Reflect.deleteProperty(navigator, "clipboard");
});

const liveRegion = (message: HTMLElement) => message.closest("[aria-live]");

describe("toasts are announced", () => {
  it("on the Recovery page, when diagnostics were copied", async () => {
    installFakeChrome(dashboardStorage(), backgroundSendMessage());
    render(<RecoveryPage state={{ kind: "directory", code: "DIRECTORY_INVALID" }} ownerThreadsUserId={ALICE} />);

    fireEvent.click(screen.getByRole("button", { name: t("dashboard_about_copyDiagnostics") }));

    const toast = await screen.findByText(t("dashboard_about_copySuccess"));
    expect(liveRegion(toast)?.getAttribute("aria-live")).toBe("polite");
  });

  it("on the Recovery page, when they could not be copied", async () => {
    writeText.mockRejectedValue(new Error("no clipboard"));
    installFakeChrome(dashboardStorage(), backgroundSendMessage());
    render(<RecoveryPage state={{ kind: "directory", code: "DIRECTORY_INVALID" }} ownerThreadsUserId={ALICE} />);

    fireEvent.click(screen.getByRole("button", { name: t("dashboard_about_copyDiagnostics") }));

    const toast = await screen.findByText(t("dashboard_about_copyError"));
    expect(liveRegion(toast)?.getAttribute("aria-live")).toBe("polite");
  });

  it("in the Dashboard, when diagnostics were copied from About & Privacy", async () => {
    await openDashboard("#/about");

    fireEvent.click(await screen.findByRole("button", { name: t("dashboard_about_copyDiagnostics") }));

    const toast = await screen.findByText(t("dashboard_about_copySuccess"));
    expect(liveRegion(toast)?.getAttribute("aria-live")).toBe("polite");
  });

  it("(control) a message that is not in the toaster is not in a live region", async () => {
    installFakeChrome(dashboardStorage(), backgroundSendMessage());
    render(<RecoveryPage state={{ kind: "directory", code: "DIRECTORY_INVALID" }} ownerThreadsUserId={ALICE} />);

    expect(liveRegion(screen.getByText(t("recovery_noRepair")))).toBeNull();
  });
});
