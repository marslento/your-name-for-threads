import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { t } from "../../src/i18n/t";
import { App } from "../../src/popup/App";
import { GITHUB_BUG_REPORT_URL } from "../../src/shared/links";
import { TAB_SURFACES_STORAGE_KEY } from "../../src/shared/tabSurfaces";
import { __resetMigrationCoordinatorForTests } from "../../src/storage/migrations";
import { backgroundSendMessage } from "../fixtures/storage/diagnosticCoordinator";
import { installFakeChromeWithSession } from "../fixtures/storage/fakeChromeWithSession";
import { twoAccounts } from "../fixtures/storage/recoveryStorage";

/**
 * "Part of the Threads integration is currently unavailable" in the popup (Phase 4 Task 23): shown for the active
 * Threads tab only, live while the popup is open, with a way to report it and nothing private in it. The popup is
 * never gated by it: Open Directory and the on/off switch work with or without a warning.
 */
const NOTICE = () => t("integration_partialUnavailable");
const PROFILE_DEGRADED = { profile: "degraded", "post-author": "ready" };
const THREADS_TAB = { id: 7, url: "https://www.threads.com/@private_handle" };
const OTHER_SITE_TAB = { id: 7, url: "https://example.com/" };

function open(options: { tab?: { id: number; url: string }; registry?: Record<string, unknown>; unreadable?: boolean } = {}) {
  const fake = installFakeChromeWithSession(
    twoAccounts({ onboarding: { completed: true } }),
    options.registry === undefined ? {} : { [TAB_SURFACES_STORAGE_KEY]: options.registry },
    {
      tabs: { query: async () => [options.tab ?? THREADS_TAB] },
      runtime: { sendMessage: backgroundSendMessage(), getURL: (path: string) => `chrome-extension://test/${path}` },
    },
  );
  if (options.unreadable) fake.session.get = () => Promise.reject(new Error("session storage is unavailable"));
  const view = render(<App />);
  return { fake, ...view };
}

/** The popup has finished asking about the tab and reading the registry. Negative assertions are only meaningful after this. */
async function settled() {
  await screen.findByRole("button", { name: t("popup_openDashboard") });
  await act(async () => {
    for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(globalThis, "chrome");
  __resetMigrationCoordinatorForTests();
});

describe("the popup's partial-integration warning", () => {
  it("says so for the active Threads tab when one of its surfaces is degraded, and offers the bug report", async () => {
    open({ registry: { "7": PROFILE_DEGRADED } });

    expect(await screen.findByText(NOTICE())).toBeTruthy();
    const report = screen.getByRole("link", { name: t("dashboard_about_reportIssue") });
    expect(report.getAttribute("href")).toBe(GITHUB_BUG_REPORT_URL);
    expect(report.getAttribute("target")).toBe("_blank");
    expect(report.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getByText(t("integration_partialHelp"))).toBeTruthy();
  });

  it("says nothing when the active tab is fine", async () => {
    open({ registry: {} });
    await settled();

    expect(screen.queryByText(NOTICE())).toBeNull();
    expect(screen.queryByRole("link", { name: t("dashboard_about_reportIssue") })).toBeNull();
  });

  it("says nothing when only another tab is degraded", async () => {
    open({ registry: { "99": PROFILE_DEGRADED } });
    await settled();

    expect(screen.queryByText(NOTICE())).toBeNull();
  });

  it("says nothing on a page that is not Threads, even if the registry holds that tab's ID", async () => {
    open({ tab: OTHER_SITE_TAB, registry: { "7": PROFILE_DEGRADED } });
    await settled();

    expect(screen.queryByText(NOTICE())).toBeNull();
  });

  it("appears when a surface degrades while the popup is open, and goes when it recovers", async () => {
    const { fake } = open({ registry: {} });
    await settled();
    expect(screen.queryByText(NOTICE())).toBeNull();

    await act(async () => fake.session.set({ [TAB_SURFACES_STORAGE_KEY]: { "7": PROFILE_DEGRADED } }));
    expect(await screen.findByText(NOTICE())).toBeTruthy();

    await act(async () => fake.session.set({ [TAB_SURFACES_STORAGE_KEY]: {} }));
    await waitFor(() => expect(screen.queryByText(NOTICE())).toBeNull());
  });

  it("does not react to another tab's change", async () => {
    const { fake } = open({ registry: {} });
    await settled();

    await act(async () => fake.session.set({ [TAB_SURFACES_STORAGE_KEY]: { "99": PROFILE_DEGRADED } }));
    await settled();

    expect(screen.queryByText(NOTICE())).toBeNull();
  });

  it("announces itself politely, in words and with an icon that screen readers skip", async () => {
    open({ registry: { "7": PROFILE_DEGRADED } });

    const notice = await screen.findByText(NOTICE());

    expect(notice.closest("[aria-live]")?.getAttribute("aria-live")).toBe("polite");
    expect(notice.closest("[aria-live]")?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("puts nothing private in the notice: no address, handle or tab ID", async () => {
    open({ registry: { "7": PROFILE_DEGRADED } });

    const notice = (await screen.findByText(NOTICE())).closest("[aria-live]") as HTMLElement;

    expect(notice.innerHTML).not.toContain("private_handle");
    expect(notice.innerHTML).not.toContain("threads.com");
    expect(notice.textContent).not.toMatch(/\b7\b/);
    expect([...notice.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual([GITHUB_BUG_REPORT_URL]);
  });

  it("stays out of the way: the popup still works with the warning up", async () => {
    open({ registry: { "7": PROFILE_DEGRADED } });
    await screen.findByText(NOTICE());

    expect(screen.getByRole("button", { name: t("popup_openDashboard") })).toBeTruthy();
    expect(screen.getByRole("switch")).toBeTruthy();
  });

  it("shows no warning, and still works, when the registry cannot be read", async () => {
    open({ registry: { "7": PROFILE_DEGRADED }, unreadable: true });
    await settled();

    expect(screen.queryByText(NOTICE())).toBeNull();
    expect(screen.getByRole("switch")).toBeTruthy();
  });

  it("stops listening when the popup closes", async () => {
    const { fake, unmount } = open({ registry: {} });
    await settled();
    expect(fake.listenerCount()).toBeGreaterThan(0);

    unmount();

    expect(fake.listenerCount()).toBe(0);
  });
});
