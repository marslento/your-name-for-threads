import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ThreadsTabContext } from "../../src/account/AccountContextRegistry";
import { OPEN_DASHBOARD_MESSAGE_TYPE } from "../../src/account/dashboardSessionRequest";
import { App, isThreadsUrl, openOrFocusDashboard } from "../../src/popup/App";
import { PHASE_ONE_VERSION } from "../../src/shared/constants";
import type { ExtensionSettings } from "../../src/domain/settings";
import { t } from "../../src/i18n/t";

type StorageListener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void;

const TAB_CONTEXTS_KEY = "tpd:tabContexts";

function stubActiveTab(result: Promise<chrome.tabs.Tab[]>) {
  const query = vi.fn(() => result);
  vi.stubGlobal("chrome", { tabs: { query } });
  return query;
}

function installChrome(
  options: {
    activeTab?: Promise<chrome.tabs.Tab[]>;
    settings?: ExtensionSettings;
    tabContexts?: Record<number, ThreadsTabContext>;
    /** What background answers to the open-Dashboard message. */
    openDashboardAnswer?: unknown;
  } = {},
) {
  let settings: ExtensionSettings = options.settings ?? {
    enabled: true,
    nicknameDisplay: { profile: true, feed: true, replies: true, quotes: true },
  };
  const listeners = new Set<StorageListener>();
  const activeTabResult = options.activeTab ?? Promise.resolve([]);
  const sessionState: Record<string, unknown> = { [TAB_CONTEXTS_KEY]: options.tabContexts ?? {} };

  const chromeApi = {
    tabs: {
      query: vi.fn(() => activeTabResult),
      update: vi.fn(() => Promise.resolve()),
      create: vi.fn(() => Promise.resolve()),
    },
    windows: {
      update: vi.fn(() => Promise.resolve()),
    },
    runtime: {
      getURL: (path: string) => `chrome-extension://test-id/${path}`,
      getContexts: vi.fn(() => Promise.resolve([])),
      sendMessage: vi.fn((_message: unknown) => Promise.resolve(options.openDashboardAnswer ?? { ok: true, sessionId: "session-1" })),
    },
    storage: {
      local: {
        async get() {
          return {
            schemaVersion: 2,
            contacts: {},
            tombstones: {},
            identityIndex: {},
            identityCache: {},
            identityConflicts: {},
            settings,
            // These tests are about the normal popup; the first-run tour has its own file (onboarding.test.tsx).
            onboarding: { completed: true },
          };
        },
        async set(values: Record<string, unknown>) {
          if (Object.hasOwn(values, "settings")) {
            const oldValue = settings;
            settings = values.settings as ExtensionSettings;
            for (const listener of [...listeners]) {
              listener({ settings: { oldValue, newValue: settings } }, "local");
            }
          }
        },
      },
      session: {
        async get(key: string) {
          return Object.hasOwn(sessionState, key) ? { [key]: sessionState[key] } : {};
        },
        async set(values: Record<string, unknown>) {
          Object.assign(sessionState, values);
        },
      },
      onChanged: {
        addListener: (listener: StorageListener) => listeners.add(listener),
        removeListener: (listener: StorageListener) => listeners.delete(listener),
      },
    },
  };

  vi.stubGlobal("chrome", chromeApi);
  return {
    ...chromeApi,
    emitSettingsChange(next: ExtensionSettings) {
      const oldValue = settings;
      settings = next;
      for (const listener of [...listeners]) {
        listener({ settings: { oldValue, newValue: next } }, "local");
      }
    },
  };
}

function confirmedTabContext(ownerThreadsUserId: string, ownerUsername: string): ThreadsTabContext {
  return { tabId: 0, state: "confirmed", ownerThreadsUserId, ownerUsername };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("popup URL detection", () => {
  it("accepts only HTTPS pages on the exact Threads hostname", () => {
    expect(isThreadsUrl("https://www.threads.com/@alice")).toBe(true);
    expect(isThreadsUrl("http://www.threads.com/@alice")).toBe(false);
    expect(isThreadsUrl("https://threads.com/@alice")).toBe(false);
    expect(isThreadsUrl("https://www.threads.com.evil.example/@alice")).toBe(false);
    expect(isThreadsUrl("not a url")).toBe(false);
    expect(isThreadsUrl(undefined)).toBe(false);
  });
});

describe("popup", () => {
  it("shows Threads guidance and an enabled Open Directory button for a confirmed owner", async () => {
    const chromeApi = installChrome({
      activeTab: Promise.resolve([{ id: 7, url: "https://www.threads.com/@alice" } as chrome.tabs.Tab]),
      tabContexts: { 7: confirmedTabContext("123", "alice") },
    });

    render(<App />);

    expect(await screen.findByText(t("popup_threadsGuidance"))).toBeTruthy();
    expect(screen.getByRole("heading", { name: t("popup_title") })).toBeTruthy();
    const openButton = screen.getByRole("button", { name: t("popup_openDashboard") }) as HTMLButtonElement;
    await waitFor(() => expect(openButton.disabled).toBe(false));
    await waitFor(() =>
      expect((screen.getByRole("switch") as HTMLButtonElement).getAttribute("aria-checked")).toBe("true"),
    );
    expect(screen.getByText(t("popup_currentSiteLabel"))).toBeTruthy();
    expect(screen.getByText(t("popup_threadsSite"))).toBeTruthy();
    expect(screen.getByText(PHASE_ONE_VERSION)).toBeTruthy();
    expect(chromeApi.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
  });

  it("shows unresolved guidance and a disabled button on Threads without a confirmed owner", async () => {
    installChrome({
      activeTab: Promise.resolve([{ id: 7, url: "https://www.threads.com/@alice" } as chrome.tabs.Tab]),
    });

    render(<App />);

    expect(await screen.findByText(t("popup_threadsUnresolvedGuidance"))).toBeTruthy();
    expect(screen.getByText(t("popup_threadsSite"))).toBeTruthy();
    const openButton = screen.getByRole("button", { name: t("popup_openDashboard") }) as HTMLButtonElement;
    await waitFor(() => expect(openButton.disabled).toBe(true));
  });

  it("shows fail-closed guidance for non-Threads tabs", async () => {
    installChrome({
      activeTab: Promise.resolve([{ id: 8, url: "https://www.threads.com.evil.example/" } as chrome.tabs.Tab]),
    });

    render(<App />);

    expect(await screen.findByText(t("popup_nonThreadsGuidance"))).toBeTruthy();
    expect(screen.getByText(t("popup_nonThreadsSite"))).toBeTruthy();
    const openButton = screen.getByRole("button", { name: t("popup_openDashboard") }) as HTMLButtonElement;
    expect(openButton.disabled).toBe(true);
  });

  it("handles a rejected active-tab query without an unhandled error", async () => {
    stubActiveTab(Promise.reject(new Error("tabs unavailable")));

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(t("popup_nonThreadsGuidance"))).toBeTruthy();
      expect(screen.getByText(t("popup_nonThreadsSite"))).toBeTruthy();
    });
  });

  it.each([
    ["Chrome API", undefined],
    ["tabs API", {}],
    ["tabs query", { tabs: {} }],
  ])("keeps the non-Threads state when %s is missing", async (_label, chromeApi) => {
    vi.stubGlobal("chrome", chromeApi);

    expect(() => render(<App />)).not.toThrow();
    // Awaited: the popup first reads the onboarding flag, and with no Chrome API that read fails, which falls back to the normal popup.
    expect(await screen.findByText(t("popup_nonThreadsSite"))).toBeTruthy();
    expect(screen.getByText(t("popup_nonThreadsGuidance"))).toBeTruthy();
  });

  it("contains a synchronous tabs query failure", async () => {
    vi.stubGlobal("chrome", {
      tabs: {
        query: () => {
          throw new Error("query failed synchronously");
        },
      },
    });

    expect(() => render(<App />)).not.toThrow();
    expect(await screen.findByText(t("popup_nonThreadsSite"))).toBeTruthy();
    expect(screen.getByText(t("popup_nonThreadsGuidance"))).toBeTruthy();
  });

  it.each([
    ["an empty result", []],
    ["a tab without a URL", [{ id: 10 } as chrome.tabs.Tab]],
  ])("keeps the non-Threads state for %s", async (_label, tabs) => {
    const query = stubActiveTab(Promise.resolve(tabs));

    render(<App />);

    await waitFor(() => expect(query).toHaveBeenCalled());
    expect(screen.getByText(t("popup_nonThreadsSite"))).toBeTruthy();
    expect(screen.getByText(t("popup_nonThreadsGuidance"))).toBeTruthy();
  });

  it("does not report an error when a tabs query completes after unmount", async () => {
    let resolveQuery!: (tabs: chrome.tabs.Tab[]) => void;
    const pending = new Promise<chrome.tabs.Tab[]>((resolve) => {
      resolveQuery = resolve;
    });
    stubActiveTab(pending);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const unhandled: unknown[] = [];
    const captureUnhandled = (event: PromiseRejectionEvent) => unhandled.push(event.reason);
    window.addEventListener("unhandledrejection", captureUnhandled);

    try {
      const view = render(<App />);
      view.unmount();

      await act(async () => {
        resolveQuery([{ id: 11, url: "https://www.threads.com/@alice" } as chrome.tabs.Tab]);
        await pending;
      });

      expect(consoleError).not.toHaveBeenCalled();
      expect(unhandled).toEqual([]);
    } finally {
      window.removeEventListener("unhandledrejection", captureUnhandled);
    }
  });

  it("toggles settings.enabled immediately without a confirmation", async () => {
    const chromeApi = installChrome({
      settings: { enabled: true, nicknameDisplay: { profile: true, feed: true, replies: true, quotes: true } },
    });
    render(<App />);
    const toggle = await screen.findByRole("switch");
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));

    fireEvent.click(toggle);

    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    const stored = await chromeApi.storage.local.get();
    expect(stored.settings.enabled).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("reflects a live settings change made elsewhere (e.g. the Dashboard)", async () => {
    const chromeApi = installChrome({
      settings: { enabled: true, nicknameDisplay: { profile: true, feed: true, replies: true, quotes: true } },
    });
    render(<App />);
    const toggle = await screen.findByRole("switch");
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));

    act(() => {
      chromeApi.emitSettingsChange({
        enabled: false,
        nicknameDisplay: { profile: true, feed: true, replies: true, quotes: true },
      });
    });

    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
  });
});

const OWNER = { tabId: 7, ownerThreadsUserId: "123", ownerUsername: "alice" };

describe("openOrFocusDashboard", () => {
  // The Dashboard's life belongs to the background (src/background/dashboardLifecycle.ts): it opens the tab, so
  // it knows which tab to close when the source is gone. The popup asks, and does nothing else.
  it("asks background to open the Dashboard for its own source tab, and sends nothing about who the owner is", async () => {
    const chromeApi = installChrome({ tabContexts: { [OWNER.tabId]: confirmedTabContext("123", "alice") } });

    await expect(openOrFocusDashboard(OWNER)).resolves.toBeUndefined();

    expect(chromeApi.runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(chromeApi.runtime.sendMessage).toHaveBeenCalledWith({ type: OPEN_DASHBOARD_MESSAGE_TYPE, sourceTabId: 7 });
  });

  it("opens, focuses and looks up no tab or window itself", async () => {
    const chromeApi = installChrome();

    await openOrFocusDashboard(OWNER);

    expect(chromeApi.tabs.create).not.toHaveBeenCalled();
    expect(chromeApi.tabs.update).not.toHaveBeenCalled();
    expect(chromeApi.windows.update).not.toHaveBeenCalled();
    expect(chromeApi.runtime.getContexts).not.toHaveBeenCalled();
  });

  it("rejects with background's reason when it cannot open a Dashboard for that tab", async () => {
    installChrome({ openDashboardAnswer: { ok: false, error: "source_tab_not_confirmed" } });

    await expect(openOrFocusDashboard(OWNER)).rejects.toThrow("source_tab_not_confirmed");
  });

  it("rejects when background answers with something that is not a success", async () => {
    installChrome({ openDashboardAnswer: undefined });
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValueOnce("not an answer" as never);

    await expect(openOrFocusDashboard(OWNER)).rejects.toThrow("Background did not open the Dashboard.");
  });

  it("clicking the Open Directory button drives openOrFocusDashboard for the confirmed owner", async () => {
    const chromeApi = installChrome({
      activeTab: Promise.resolve([{ id: 7, url: "https://www.threads.com/@alice" } as chrome.tabs.Tab]),
      tabContexts: { 7: confirmedTabContext("123", "alice") },
    });
    render(<App />);

    const openButton = await screen.findByRole("button", { name: t("popup_openDashboard") });
    await waitFor(() => expect((openButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(openButton);

    await waitFor(() =>
      expect(chromeApi.runtime.sendMessage).toHaveBeenCalledWith({ type: OPEN_DASHBOARD_MESSAGE_TYPE, sourceTabId: 7 }),
    );
  });

  it("clicking the disabled Open Directory button does nothing without a confirmed owner", async () => {
    const chromeApi = installChrome({
      activeTab: Promise.resolve([{ id: 7, url: "https://www.threads.com/@alice" } as chrome.tabs.Tab]),
    });
    render(<App />);

    const openButton = await screen.findByRole("button", { name: t("popup_openDashboard") });
    await waitFor(() => expect((openButton as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(openButton);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(chromeApi.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: OPEN_DASHBOARD_MESSAGE_TYPE }));
  });
});
