import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AboutPage } from "../../src/dashboard/routes/AboutPage";
import { __resetDiagnosticReportsForTests } from "../../src/diagnostics/reportDiagnostic";
import { t } from "../../src/i18n/t";
import { GITHUB_BUG_REPORT_URL } from "../../src/shared/links";
import { TAB_SURFACES_STORAGE_KEY } from "../../src/shared/tabSurfaces";
import { __resetMigrationCoordinatorForTests } from "../../src/storage/migrations";
import { backgroundSendMessage } from "../fixtures/storage/diagnosticCoordinator";
import { installFakeChromeWithSession } from "../fixtures/storage/fakeChromeWithSession";
import { ALICE, twoAccounts } from "../fixtures/storage/recoveryStorage";

/**
 * The same warning in About & Privacy, and the surface status in the diagnostics a person copies (Phase 4 Task 23).
 * About is not a Threads tab, so it speaks for every open Threads tab: degraded wherever any of them is. When
 * nothing is degraded it reports "not reported" rather than "ready", because no Threads tab may be open at all.
 */
const NOTICE = () => t("integration_partialUnavailable");
const PROFILE_DEGRADED = { profile: "degraded", "post-author": "ready" };
const FEED_DEGRADED = { profile: "ready", "post-author": "degraded" };

let writeText: ReturnType<typeof vi.fn>;

function open(registry?: Record<string, unknown>, ownerThreadsUserId?: string) {
  const fake = installFakeChromeWithSession(twoAccounts(), registry === undefined ? {} : { [TAB_SURFACES_STORAGE_KEY]: registry }, {
    runtime: { sendMessage: backgroundSendMessage() },
  });
  render(<AboutPage ownerThreadsUserId={ownerThreadsUserId} />);
  return fake;
}

async function copiedSummary(): Promise<string> {
  fireEvent.click(screen.getByRole("button", { name: t("dashboard_about_copyDiagnostics") }));
  await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
  return writeText.mock.calls[0][0] as string;
}

async function settled() {
  await act(async () => {
    for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

beforeEach(() => {
  __resetDiagnosticReportsForTests();
  writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  vi.spyOn(toast, "success").mockReturnValue("toast");
  vi.spyOn(toast, "error").mockReturnValue("toast");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "clipboard");
  Reflect.deleteProperty(globalThis, "chrome");
  __resetMigrationCoordinatorForTests();
});

describe("About & Privacy: the partial-integration warning", () => {
  it("says so when any open Threads tab has a degraded surface, and there is a way to report it", async () => {
    open({ "4711": PROFILE_DEGRADED });

    expect(await screen.findByText(NOTICE())).toBeTruthy();
    const reports = screen.getAllByRole("link", { name: t("dashboard_about_reportIssue") });
    expect(reports.map((link) => link.getAttribute("href"))).toEqual([GITHUB_BUG_REPORT_URL, GITHUB_BUG_REPORT_URL]); // the notice's and the support section's
  });

  it("says nothing when no tab has anything wrong", async () => {
    open({});
    await settled();

    expect(screen.queryByText(NOTICE())).toBeNull();
    expect(screen.getAllByRole("link", { name: t("dashboard_about_reportIssue") })).toHaveLength(1);
  });

  it("says nothing when the registry is empty or has never been written", async () => {
    open();
    await settled();

    expect(screen.queryByText(NOTICE())).toBeNull();
  });

  it("follows the registry while it is open", async () => {
    const fake = open({});
    await settled();

    await act(async () => fake.session.set({ [TAB_SURFACES_STORAGE_KEY]: { "4711": FEED_DEGRADED } }));
    expect(await screen.findByText(NOTICE())).toBeTruthy();

    await act(async () => fake.session.set({ [TAB_SURFACES_STORAGE_KEY]: {} }));
    await waitFor(() => expect(screen.queryByText(NOTICE())).toBeNull());
  });

  it("stops listening when the page closes", async () => {
    const fake = open({});
    await settled();
    const during = fake.listenerCount();
    expect(during).toBeGreaterThan(0);

    cleanup();

    expect(fake.listenerCount()).toBeLessThan(during);
  });
});

describe("About & Privacy: surface status in the copied diagnostics", () => {
  it("names the degraded surface", async () => {
    open({ "4711": PROFILE_DEGRADED });
    await screen.findByText(NOTICE());

    expect(await copiedSummary()).toContain("Runtime surface status: profile=degraded, post-author=ready");
  });

  it("combines tabs: degraded wherever any tab has it degraded", async () => {
    open({ "1": PROFILE_DEGRADED, "2": FEED_DEGRADED });
    await screen.findByText(NOTICE());

    expect(await copiedSummary()).toContain("Runtime surface status: profile=degraded, post-author=degraded");
  });

  it("says 'not reported' when nothing is degraded, because no Threads tab may be open", async () => {
    open({});
    await settled();

    expect(await copiedSummary()).toContain("Runtime surface status: not reported");
  });

  it("still says who the account is, and only that, alongside the surfaces", async () => {
    open({ "4711": PROFILE_DEGRADED }, ALICE);
    await screen.findByText(NOTICE());

    const summary = await copiedSummary();

    expect(summary).toContain("Runtime surface status: profile=degraded, post-author=ready");
    expect(summary).toContain("Account resolver state: confirmed");
    expect(summary).toContain("Recovery state: none");
  });

  it("carries no tab ID", async () => {
    open({ "4711": PROFILE_DEGRADED });
    await screen.findByText(NOTICE());

    expect(await copiedSummary()).not.toContain("4711");
  });
});
