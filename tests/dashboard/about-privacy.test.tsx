import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../../src/dashboard/App";
import { AboutPage } from "../../src/dashboard/routes/AboutPage";
import { __resetDiagnosticReportsForTests } from "../../src/diagnostics/reportDiagnostic";
import { t } from "../../src/i18n/t";
import {
  GITHUB_BUG_REPORT_URL,
  GITHUB_ISSUES_URL,
  GITHUB_REPO_URL,
  PRIVACY_POLICY_URL,
  SECURITY_POLICY_URL,
} from "../../src/shared/links";
import { backgroundSendMessage } from "../fixtures/storage/diagnosticCoordinator";
import { installFakeChrome } from "../fixtures/storage/fakeChromeStorage";

const OWNER = "17841400000000000";
const NOW = "2026-09-19T04:30:12.345Z";
const PRIVATE = ["alice_handle", "17841499999999999", "Big Alice", "secret note about her", "c-secret-1", "dir-secret-42", OWNER];

const healthyStorage = () => ({
  schemaVersion: 4,
  directories: {
    "dir-secret-42": {
      directoryId: "dir-secret-42",
      contacts: {
        "c-secret-1": { id: "c-secret-1", username: "alice_handle", threadsUserId: "17841499999999999", nickname: "Big Alice", note: "secret note about her", createdAt: NOW, updatedAt: NOW, identityUpdatedAt: NOW },
      },
      tombstones: {},
      identityIndex: {},
      identityConflicts: {},
    },
  },
  accountBindings: { [OWNER]: "dir-secret-42" },
  identityCache: {},
  settings: { enabled: true, nicknameDisplay: { profile: true, feed: true, replies: true, quotes: true } },
});

const event = (n: number) => ({
  code: "STORAGE_VALIDATION_FAILED",
  component: "storage",
  occurredAt: new Date(Date.UTC(2026, 8, 19, 0, 0, n)).toISOString(),
  extensionVersion: "1.0.0",
});

let writeText: ReturnType<typeof vi.fn>;
let success: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

function installClipboard(impl: () => Promise<void> = async () => undefined) {
  writeText = vi.fn(impl);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
}

beforeEach(() => {
  __resetDiagnosticReportsForTests();
  installClipboard();
  success = vi.spyOn(toast, "success").mockReturnValue("toast");
  error = vi.spyOn(toast, "error").mockReturnValue("toast");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "clipboard");
  Reflect.deleteProperty(globalThis, "chrome");
});

const button = (key: string) => screen.getByRole("button", { name: t(key) });
const link = (key: string) => screen.getByRole("link", { name: t(key) });

describe("About & Privacy: content", () => {
  it("has one page heading and a section heading for each part of the page", () => {
    installFakeChrome(healthyStorage(), backgroundSendMessage());
    render(<AboutPage ownerThreadsUserId={OWNER} />);

    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual([t("dashboard_sidebar_about")]);
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      t("extension_name"),
      t("dashboard_about_privacyHeading"),
      t("dashboard_about_supportHeading"),
      t("dashboard_about_linksHeading"),
      t("dashboard_about_independentHeading"),
    ]);
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      t("dashboard_about_backupHeading"),
      t("dashboard_about_sharedHeading"),
    ]);
  });

  it.each([
    "extension_name",
    "dashboard_about_intro",
    "dashboard_about_supportedBrowsers",
    "dashboard_about_privacyLocal",
    "dashboard_about_privacyNoTelemetry",
    "dashboard_about_backupReminder",
    "dashboard_about_privacyBackup",
    "dashboard_about_privacySharedProfile",
    "dashboard_about_privacySharedProfileLimit",
    "dashboard_about_supportHelp",
    "dashboard_about_supportDiagnostics",
    "dashboard_about_supportPrivate",
    "dashboard_about_independent",
    "dashboard_about_vibeCoding",
    "dashboard_about_nameNote",
  ])("shows %s", (key) => {
    installFakeChrome(healthyStorage(), backgroundSendMessage());
    render(<AboutPage ownerThreadsUserId={OWNER} />);

    expect(screen.getByText(t(key))).toBeTruthy();
  });

  it("keeps the product name, the version and the replay-the-tour entry", () => {
    installFakeChrome(healthyStorage(), backgroundSendMessage());
    render(<AboutPage ownerThreadsUserId={OWNER} />);

    expect(screen.getByText(t("popup_versionLabel"))).toBeTruthy();
    expect(button("dashboard_about_replayTour")).toBeTruthy();
  });

  it("never claims more than the design allows, on the page as rendered", () => {
    installFakeChrome(healthyStorage(), backgroundSendMessage());
    const { container } = render(<AboutPage ownerThreadsUserId={OWNER} />);

    expect(container.textContent ?? "").not.toMatch(/100%|guarantee|completely secure|絕對|完全安全|保證|百分之百/i);
  });
});

describe("About & Privacy: links (navigation only)", () => {
  it.each([
    ["dashboard_about_linkSource", GITHUB_REPO_URL],
    ["dashboard_about_linkIssues", GITHUB_ISSUES_URL],
    ["dashboard_about_linkPrivacy", PRIVACY_POLICY_URL],
    ["dashboard_about_reportIssue", GITHUB_BUG_REPORT_URL],
    ["dashboard_about_linkSecurity", SECURITY_POLICY_URL],
  ])("%s goes to its address", (key, href) => {
    installFakeChrome(healthyStorage(), backgroundSendMessage());
    render(<AboutPage ownerThreadsUserId={OWNER} />);

    expect(link(key).getAttribute("href")).toBe(href);
  });

  it("opens every external link in a new tab, without handing the page to the opener", () => {
    installFakeChrome(healthyStorage(), backgroundSendMessage());
    const { container } = render(<AboutPage ownerThreadsUserId={OWNER} />);

    const anchors = [...container.querySelectorAll("a")];
    expect(anchors.length).toBe(5);
    for (const anchor of anchors) {
      expect(anchor.getAttribute("target")).toBe("_blank");
      expect(anchor.getAttribute("rel")).toContain("noopener");
      expect(anchor.getAttribute("rel")).toContain("noreferrer");
    }
  });

  it("makes no network request of its own", async () => {
    installFakeChrome(healthyStorage(), backgroundSendMessage());
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    render(<AboutPage ownerThreadsUserId={OWNER} />);

    fireEvent.click(button("dashboard_about_copyDiagnostics"));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    fireEvent.click(button("dashboard_about_clearDiagnostics"));
    await waitFor(() => expect(success).toHaveBeenCalledTimes(2));

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("Copy diagnostics (Task 11)", () => {
  it("copies the summary, and none of the private data that sits in the same storage", async () => {
    installFakeChrome({ ...healthyStorage(), diagnostics: [event(1)] }, backgroundSendMessage());
    render(<AboutPage ownerThreadsUserId={OWNER} />);

    fireEvent.click(button("dashboard_about_copyDiagnostics"));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied.startsWith("Your Name for Threads Diagnostics")).toBe(true);
    expect(copied).toContain("Account resolver state: confirmed");
    expect(copied).toContain("Directory exists: yes");
    expect(copied).toContain("Contact count: 1");
    expect(copied).toContain("STORAGE_VALIDATION_FAILED");
    for (const text of PRIVATE) expect(copied, `leaked ${text}`).not.toContain(text);
    expect(success).toHaveBeenCalledWith(t("dashboard_about_copySuccess"));
    expect(error).not.toHaveBeenCalled();
  });

  it("does not claim an account it was not given", async () => {
    installFakeChrome(healthyStorage(), backgroundSendMessage());
    render(<AboutPage />);

    fireEvent.click(button("dashboard_about_copyDiagnostics"));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toContain("Account resolver state: not available in this context");
    expect(copied).toContain("Directory exists: not available in this context");
  });

  it("is a pure read: copying changes nothing in storage", async () => {
    const storage = installFakeChrome({ ...healthyStorage(), diagnostics: [event(1)] }, backgroundSendMessage());
    const before = storage.snapshot();
    render(<AboutPage ownerThreadsUserId={OWNER} />);

    fireEvent.click(button("dashboard_about_copyDiagnostics"));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

    expect(storage.snapshot()).toEqual(before);
    expect(storage.writeCount()).toBe(0);
  });

  it("puts no diagnostic text into the bug-report link, before or after copying (Task 11)", async () => {
    installFakeChrome({ ...healthyStorage(), diagnostics: [event(1)] }, backgroundSendMessage());
    const { container } = render(<AboutPage ownerThreadsUserId={OWNER} />);
    expect(link("dashboard_about_reportIssue").getAttribute("href")).toBe(GITHUB_BUG_REPORT_URL);

    fireEvent.click(button("dashboard_about_copyDiagnostics"));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

    for (const anchor of container.querySelectorAll("a")) {
      const href = decodeURIComponent(anchor.getAttribute("href") ?? "");
      expect(href).not.toMatch(/Diagnostics|Storage schema|STORAGE_VALIDATION_FAILED|Contact count/);
    }
    expect(link("dashboard_about_reportIssue").getAttribute("href")).toBe(GITHUB_BUG_REPORT_URL);
    expect(new URL(GITHUB_BUG_REPORT_URL).searchParams.has("body")).toBe(false);
  });

  it("copies once for a double click, and tells the user when it worked", async () => {
    installFakeChrome(healthyStorage(), backgroundSendMessage());
    installClipboard(() => new Promise((resolve) => setTimeout(resolve, 30)));
    render(<AboutPage ownerThreadsUserId={OWNER} />);

    fireEvent.click(button("dashboard_about_copyDiagnostics"));
    fireEvent.click(button("dashboard_about_copyDiagnostics"));

    await waitFor(() => expect(success).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["the browser refuses the write", () => installClipboard(async () => Promise.reject(new Error("NotAllowedError")))],
    ["there is no clipboard API", () => Reflect.deleteProperty(navigator, "clipboard")],
  ])("says so, and stays usable, when %s", async (_label, arrange) => {
    installFakeChrome(healthyStorage(), backgroundSendMessage());
    arrange();
    render(<AboutPage ownerThreadsUserId={OWNER} />);

    fireEvent.click(button("dashboard_about_copyDiagnostics"));

    await waitFor(() => expect(error).toHaveBeenCalledWith(t("dashboard_about_copyError")));
    expect(success).not.toHaveBeenCalled();
    expect(button("dashboard_about_copyDiagnostics").hasAttribute("disabled")).toBe(false);
  });
});

describe("Clear diagnostics", () => {
  it("removes the recorded events, and says so", async () => {
    const storage = installFakeChrome({ ...healthyStorage(), diagnostics: [event(1), event(2)] }, backgroundSendMessage());
    render(<AboutPage ownerThreadsUserId={OWNER} />);

    fireEvent.click(button("dashboard_about_clearDiagnostics"));

    await waitFor(() => expect(success).toHaveBeenCalledWith(t("dashboard_about_clearSuccess")));
    expect(Object.hasOwn(storage.snapshot(), "diagnostics")).toBe(false);
  });

  it("leaves the Directory and every other key alone", async () => {
    const original = { ...healthyStorage(), onboarding: { completed: true } };
    const storage = installFakeChrome({ ...original, diagnostics: [event(1)] }, backgroundSendMessage());
    render(<AboutPage ownerThreadsUserId={OWNER} />);

    fireEvent.click(button("dashboard_about_clearDiagnostics"));
    await waitFor(() => expect(success).toHaveBeenCalled());

    expect(storage.snapshot()).toEqual(original);
  });

  it.each([
    ["the coordinator refuses", (s: ReturnType<typeof installFakeChrome>) => { s.remove = () => Promise.reject(new Error("locked")); }],
    ["the coordinator cannot be reached", (_s: ReturnType<typeof installFakeChrome>) => {
      (globalThis as unknown as { chrome: { runtime: { sendMessage: unknown } } }).chrome.runtime.sendMessage = async () => Promise.reject(new Error("no receiver"));
    }],
  ])("says it could not clear, rather than claiming success, when %s", async (_label, arrange) => {
    const storage = installFakeChrome({ ...healthyStorage(), diagnostics: [event(1)] }, backgroundSendMessage());
    arrange(storage);
    render(<AboutPage ownerThreadsUserId={OWNER} />);

    fireEvent.click(button("dashboard_about_clearDiagnostics"));

    await waitFor(() => expect(error).toHaveBeenCalledWith(t("dashboard_about_clearError")));
    expect(success).not.toHaveBeenCalled();
    expect(storage.snapshot().diagnostics).toEqual([event(1)]);
  });
});

describe("in the Dashboard", () => {
  it("passes the confirmed owner down, so the copied summary counts that account's Directory", async () => {
    installFakeChrome(healthyStorage(), backgroundSendMessage());
    window.location.hash = "#/about";
    render(
      <App
        accountResolver={{
          getState: () => ({ state: "confirmed", ownerThreadsUserId: OWNER, ownerUsername: "owner" }),
          subscribe: () => () => undefined,
        }}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: t("dashboard_about_copyDiagnostics") }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toContain("Account resolver state: confirmed");
    expect(copied).toContain("Directory exists: yes");
    expect(within(screen.getByRole("navigation")).getByRole("link", { name: t("dashboard_sidebar_about") })).toBeTruthy();
  });
});
