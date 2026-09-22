import { afterEach, describe, expect, it, vi } from "vitest";

import { OPEN_DASHBOARD_MESSAGE_TYPE } from "../../src/account/dashboardSessionRequest";
import { REPORT_ACCOUNT_CONTEXT_MESSAGE_TYPE } from "../../src/account/reportAccountContext";
import { SOURCE_UNLOADING_MESSAGE_TYPE } from "../../src/account/sourceDocumentLifecycle";
import { ThreadsAccountResolver } from "../../src/account/ThreadsAccountResolver";
import { installFakeChromeStorage } from "../fixtures/storage/fakeChromeStorage";
import { installFakeDashboardBrowser } from "../fixtures/storage/fakeDashboardBrowser";
import { migrationCoordinatorSendMessage } from "../fixtures/storage/migrationCoordinator";

type MessageListener = (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => boolean | undefined;
type RemovedListener = (tabId: number, removeInfo: unknown) => void;
type UpdatedListener = (tabId: number, changeInfo: { status?: string; url?: string }, tab: { url?: string }) => void;

/** The fake Dashboard browser (tabs, session storage, pings) plus the event surface the worker registers against. */
function installFakeChrome() {
  const browser = installFakeDashboardBrowser();
  const chromeApi = (globalThis as unknown as { chrome: Record<string, Record<string, unknown>> }).chrome;
  const messageListeners = new Set<MessageListener>();
  const removedListeners = new Set<RemovedListener>();
  const updatedListeners = new Set<UpdatedListener>();
  const sessionWrites: Record<string, unknown>[] = [];
  const installedListeners = new Set<() => void>();

  const storageSession = chromeApi.storage.session as { set(values: Record<string, unknown>): Promise<void> };
  const set = storageSession.set.bind(storageSession);
  storageSession.set = async (values) => {
    await set(values);
    sessionWrites.push(JSON.parse(JSON.stringify(values)) as Record<string, unknown>);
  };
  Object.assign(chromeApi.runtime, {
    onInstalled: { addListener: (l: () => void) => installedListeners.add(l) },
    onMessage: { addListener: (l: MessageListener) => messageListeners.add(l) },
    onConnect: { addListener: () => {} },
    sendMessage: migrationCoordinatorSendMessage(),
  });
  chromeApi.storage.local = {
    async get() {
      return {};
    },
    async set() {},
    async remove() {},
  };
  Object.assign(chromeApi.tabs, {
    onRemoved: { addListener: (l: RemovedListener) => removedListeners.add(l) },
    onUpdated: { addListener: (l: UpdatedListener) => updatedListeners.add(l) },
  });

  return {
    browser,
    dispatchMessage(message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) {
      let handled: boolean | undefined;
      for (const listener of messageListeners) {
        const result = listener(message, sender, sendResponse);
        if (result) handled = result;
      }
      return handled;
    },
    /**
     * Mirrors the real Chrome event shape (Phase 3.5 review round 4, High #2): `changeInfo.url` is only ever
     * present when the URL actually changed (never for a same-URL reload), while `tab.url` always reflects the
     * tab's own current/in-flight URL - which is what production code reads.
     */
    dispatchTabUpdated(tabId: number, options: { status?: string; changeInfoUrl?: string; tabUrl?: string }) {
      const changeInfo: { status?: string; url?: string } = {};
      if (options.status !== undefined) changeInfo.status = options.status;
      if (options.changeInfoUrl !== undefined) changeInfo.url = options.changeInfoUrl;
      for (const listener of [...updatedListeners]) listener(tabId, changeInfo, { url: options.tabUrl });
    },
    dispatchTabRemoved(tabId: number) {
      for (const listener of [...removedListeners]) listener(tabId, {});
    },
    session: () => browser.session,
    /** Every write, not just the final state - a session that flickered through "invalid" and back would be invisible in a snapshot. */
    sessionWrites: () => sessionWrites,
  };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
  vi.resetModules();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const ALICE_ID = "73681567207";
const THREADS = "https://www.threads.com/@alice";
const fromTab = (tabId: number, documentId?: string, frameId = 0) => ({ tab: { id: tabId }, documentId, frameId }) as chrome.runtime.MessageSender;

type Fake = ReturnType<typeof installFakeChrome>;
const sessionsOf = (fake: Fake) => (fake.session()["tpd:dashboardSessions"] ?? {}) as Record<string, { state: string; dashboardTabId?: number }>;
const contextOf = (fake: Fake, tabId: number) =>
  (
    fake.session()["tpd:tabContexts"] as
      | Record<number, { state: string; documentId?: string; ownerThreadsUserId?: string; retiredDocumentIds?: string[] }>
      | undefined
  )?.[tabId];

/** Tab 42 proved Alice through `doc-1` (still alive), and has one Dashboard session with a real tab behind it. */
function seedAliceWithDashboard(fake: Fake) {
  fake.session()["tpd:tabContexts"] = {
    42: { tabId: 42, state: "confirmed", ownerThreadsUserId: ALICE_ID, ownerUsername: "alice", documentId: "doc-1" },
  };
  fake.session()["tpd:dashboardSessions"] = {
    "session-1": {
      sessionId: "session-1",
      ownerThreadsUserId: ALICE_ID,
      ownerUsername: "alice",
      sourceTabId: 42,
      sourceDocumentId: "doc-1",
      dashboardTabId: 100,
      state: "active",
    },
  };
  fake.browser.liveDocuments.add("doc-1");
  fake.browser.tabs.set(100, {
    id: 100,
    url: "chrome-extension://fake-extension-id/dashboard.html?session=session-1#/directory",
    status: "complete",
    windowId: 1,
    committed: true,
  });
}

describe("background service worker: account context relay", () => {
  it("relays a reporting tab's context into the registry, keyed by sender.tab.id and its document by sender.documentId", async () => {
    const fake = installFakeChrome();
    await import("../../src/background/serviceWorker");

    const sendResponse = vi.fn();
    fake.dispatchMessage(
      { type: REPORT_ACCOUNT_CONTEXT_MESSAGE_TYPE, state: "confirmed", ownerThreadsUserId: "123", ownerUsername: "alice" },
      fromTab(42, "doc-9"),
      sendResponse,
    );
    await settle();

    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    expect(contextOf(fake, 42)).toMatchObject({ tabId: 42, state: "confirmed", ownerThreadsUserId: "123", documentId: "doc-9" });
  });

  it("ignores a report with no sender.tab.id (not a real content-script tab)", async () => {
    const fake = installFakeChrome();
    await import("../../src/background/serviceWorker");

    const sendResponse = vi.fn();
    fake.dispatchMessage(
      { type: REPORT_ACCOUNT_CONTEXT_MESSAGE_TYPE, state: "confirmed", ownerThreadsUserId: "123" },
      {} as chrome.runtime.MessageSender,
      sendResponse,
    );
    await settle();

    expect(sendResponse).not.toHaveBeenCalled();
    expect(fake.session()).not.toHaveProperty("tpd:tabContexts");
  });

  it("ignores a report that did not come from the tab's top-level page", async () => {
    const fake = installFakeChrome();
    await import("../../src/background/serviceWorker");

    const sendResponse = vi.fn();
    fake.dispatchMessage(
      { type: REPORT_ACCOUNT_CONTEXT_MESSAGE_TYPE, state: "confirmed", ownerThreadsUserId: "123", ownerUsername: "alice" },
      fromTab(42, "doc-in-a-frame", 7),
      sendResponse,
    );
    await settle();

    expect(sendResponse).not.toHaveBeenCalled();
    expect(fake.session()).not.toHaveProperty("tpd:tabContexts");
  });

  it("ignores unrelated messages", async () => {
    const fake = installFakeChrome();
    await import("../../src/background/serviceWorker");

    const sendResponse = vi.fn();
    const handled = fake.dispatchMessage({ type: "something-else" }, fromTab(1), sendResponse);

    expect(handled).toBeUndefined();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it("ends the Dashboard session backed by the reporting tab when the tab stops proving the account (DL05)", async () => {
    const fake = installFakeChrome();
    seedAliceWithDashboard(fake);
    await import("../../src/background/serviceWorker");

    fake.dispatchMessage({ type: REPORT_ACCOUNT_CONTEXT_MESSAGE_TYPE, state: "unresolved" }, fromTab(42, "doc-1"), () => {});
    await settle();

    expect(sessionsOf(fake)["session-1"].state).toBe("invalid");
    expect(fake.browser.removeCalls).toEqual([100]);
  });

  it("never lets a stale content script's 'revalidating' hold a Dashboard open", async () => {
    const fake = installFakeChrome();
    seedAliceWithDashboard(fake);
    await import("../../src/background/serviceWorker");

    fake.dispatchMessage(
      { type: REPORT_ACCOUNT_CONTEXT_MESSAGE_TYPE, state: "revalidating", ownerThreadsUserId: ALICE_ID, ownerUsername: "alice" },
      fromTab(42, "doc-1"),
      () => {},
    );
    await settle();

    expect(sessionsOf(fake)["session-1"].state).toBe("invalid");
  });
});

describe("background service worker: the source page's own messages", () => {
  it("ends the Dashboard as soon as the source announces it is being navigated away from (DL02), and answers", async () => {
    const fake = installFakeChrome();
    seedAliceWithDashboard(fake);
    await import("../../src/background/serviceWorker");

    const sendResponse = vi.fn();
    const kept = fake.dispatchMessage({ type: SOURCE_UNLOADING_MESSAGE_TYPE }, fromTab(42, "doc-1"), sendResponse);
    await settle();

    expect(kept).toBe(true);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    expect(sessionsOf(fake)["session-1"].state).toBe("invalid");
    expect(fake.browser.removeCalls).toEqual([100]);
    // The old page's proof goes with it (Codex review 2026-09-22, F1): a Dashboard opened now would be the old page's
    // authority outliving the reload it is part of.
    expect(contextOf(fake, 42)).toMatchObject({ state: "unresolved", retiredDocumentIds: ["doc-1"] });
  });

  it("F1: while that reload is still on the network the popup's open request is refused, and nothing is opened", async () => {
    const fake = installFakeChrome();
    seedAliceWithDashboard(fake);
    await import("../../src/background/serviceWorker");
    fake.dispatchMessage({ type: SOURCE_UNLOADING_MESSAGE_TYPE }, fromTab(42, "doc-1"), () => {});
    await settle();

    const sendResponse = vi.fn();
    fake.dispatchMessage({ type: OPEN_DASHBOARD_MESSAGE_TYPE, sourceTabId: 42 }, {} as chrome.runtime.MessageSender, sendResponse);
    await settle();

    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: "source_tab_not_confirmed" });
    expect(fake.browser.created).toEqual([]);
  });

  it("ignores that announcement from a frame, from a non-tab sender, and about another document", async () => {
    const fake = installFakeChrome();
    seedAliceWithDashboard(fake);
    await import("../../src/background/serviceWorker");

    fake.dispatchMessage({ type: SOURCE_UNLOADING_MESSAGE_TYPE }, fromTab(42, "doc-1", 3), () => {});
    fake.dispatchMessage({ type: SOURCE_UNLOADING_MESSAGE_TYPE }, {} as chrome.runtime.MessageSender, () => {});
    fake.dispatchMessage({ type: SOURCE_UNLOADING_MESSAGE_TYPE }, fromTab(42, "another-doc"), () => {});
    await settle();

    expect(sessionsOf(fake)["session-1"].state).toBe("active");
  });
});

describe("background service worker: tab events (DL01-DL03, DL10)", () => {
  it("DL10: an in-page navigation reads as loading with a Threads URL, and the same page still answers - the Dashboard stays", async () => {
    const fake = installFakeChrome();
    seedAliceWithDashboard(fake);
    await import("../../src/background/serviceWorker");

    // history.pushState to another Threads URL: measured in Chromium as { status: "loading", url } then "complete".
    fake.dispatchTabUpdated(42, { status: "loading", changeInfoUrl: "https://www.threads.com/@bob", tabUrl: "https://www.threads.com/@bob" });
    // ...and a same-URL pushState, which is indistinguishable from a reload by the event alone.
    fake.dispatchTabUpdated(42, { status: "loading", tabUrl: THREADS });
    await settle();

    expect(sessionsOf(fake)["session-1"].state).toBe("active");
    expect(contextOf(fake, 42)?.state).toBe("confirmed");
    expect(fake.browser.removeCalls).toEqual([]);
  });

  it("DL01: a reload (same URL, no changeInfo.url) ends the Dashboard when the old document no longer answers", async () => {
    const fake = installFakeChrome();
    seedAliceWithDashboard(fake);
    await import("../../src/background/serviceWorker");
    fake.browser.liveDocuments.delete("doc-1");

    fake.dispatchTabUpdated(42, { status: "loading", tabUrl: THREADS });
    await settle();

    expect(sessionsOf(fake)["session-1"].state).toBe("invalid");
    expect(fake.browser.removeCalls).toEqual([100]);
    expect(contextOf(fake, 42)).toMatchObject({ state: "unresolved", retiredDocumentIds: ["doc-1"] });
  });

  it("DL01: a full navigation to another Threads URL ends it too", async () => {
    const fake = installFakeChrome();
    seedAliceWithDashboard(fake);
    await import("../../src/background/serviceWorker");
    fake.browser.liveDocuments.delete("doc-1");

    fake.dispatchTabUpdated(42, { status: "loading", changeInfoUrl: "https://www.threads.com/@bob", tabUrl: "https://www.threads.com/@bob" });
    await settle();

    expect(sessionsOf(fake)["session-1"].state).toBe("invalid");
  });

  it("DL03: leaving Threads for another origin, where the browser withholds the URL as undefined (as Edge 153 does), ends it at once", async () => {
    const fake = installFakeChrome();
    seedAliceWithDashboard(fake);
    await import("../../src/background/serviceWorker");

    // Observed in Edge 153 with only the Threads host permission: { status: "loading" } with neither changeInfo.url
    // nor tab.url (docs/release/permission-audit.md). Not held for a grace period any more.
    fake.dispatchTabUpdated(42, { status: "loading" });
    await settle();

    expect(sessionsOf(fake)["session-1"].state).toBe("invalid");
    expect(contextOf(fake, 42)?.state).toBe("unresolved");
    expect(fake.browser.pings).toEqual([]);
  });

  it("ends it too when the URL arrives as a readable foreign one", async () => {
    const fake = installFakeChrome();
    seedAliceWithDashboard(fake);
    await import("../../src/background/serviceWorker");

    fake.dispatchTabUpdated(42, { status: "loading", changeInfoUrl: "https://example.com/", tabUrl: "https://example.com/" });
    await settle();

    expect(sessionsOf(fake)["session-1"].state).toBe("invalid");
  });

  it("ignores a non-loading status update (e.g. status: complete) - only loading can mean a new document", async () => {
    const fake = installFakeChrome();
    seedAliceWithDashboard(fake);
    await import("../../src/background/serviceWorker");
    fake.browser.liveDocuments.delete("doc-1");

    fake.dispatchTabUpdated(42, { status: "complete", tabUrl: THREADS });
    await settle();

    expect(sessionsOf(fake)["session-1"].state).toBe("active");
    expect(fake.browser.pings).toEqual([]);
  });

  it("does nothing for a tab that never proved an account", async () => {
    const fake = installFakeChrome();
    await import("../../src/background/serviceWorker");

    fake.dispatchTabUpdated(99, { status: "loading", changeInfoUrl: "https://example.com/", tabUrl: "https://example.com/" });
    await settle();

    expect(fake.session()).not.toHaveProperty("tpd:tabContexts");
    expect(fake.browser.pings).toEqual([]);
  });

  it("DL04: closing the source tab ends its Dashboard and forgets its proof", async () => {
    const fake = installFakeChrome();
    seedAliceWithDashboard(fake);
    await import("../../src/background/serviceWorker");

    fake.dispatchTabRemoved(42);
    await settle();

    expect(sessionsOf(fake)["session-1"].state).toBe("invalid");
    expect(fake.browser.removeCalls).toEqual([100]);
    expect(contextOf(fake, 42)).toBeUndefined();
  });

  it("DL16: closing the Dashboard tab ends only its session - the source keeps its proof", async () => {
    const fake = installFakeChrome();
    seedAliceWithDashboard(fake);
    await import("../../src/background/serviceWorker");
    fake.browser.tabs.delete(100);

    fake.dispatchTabRemoved(100);
    await settle();

    expect(sessionsOf(fake)["session-1"]).toBeUndefined();
    expect(contextOf(fake, 42)?.state).toBe("confirmed");
    expect(fake.browser.removeCalls).toEqual([]);
  });
});

describe("background service worker: opening a Dashboard", () => {
  it("opens the Dashboard for a confirmed tab, answers with the session, and keeps the channel open for the async reply", async () => {
    const fake = installFakeChrome();
    fake.session()["tpd:tabContexts"] = {
      42: { tabId: 42, state: "confirmed", ownerThreadsUserId: ALICE_ID, ownerUsername: "alice", documentId: "doc-1" },
    };
    await import("../../src/background/serviceWorker");

    const sendResponse = vi.fn();
    const kept = fake.dispatchMessage({ type: OPEN_DASHBOARD_MESSAGE_TYPE, sourceTabId: 42 }, {} as chrome.runtime.MessageSender, sendResponse);
    await settle();

    expect(kept).toBe(true);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, sessionId: expect.any(String) });
    expect(fake.browser.created).toHaveLength(1);
    expect(Object.values(sessionsOf(fake))).toEqual([expect.objectContaining({ state: "active", dashboardTabId: fake.browser.created[0] })]);
  });

  it("refuses a tab that is not confirmed, and opens nothing", async () => {
    const fake = installFakeChrome();
    await import("../../src/background/serviceWorker");

    const sendResponse = vi.fn();
    fake.dispatchMessage({ type: OPEN_DASHBOARD_MESSAGE_TYPE, sourceTabId: 42 }, {} as chrome.runtime.MessageSender, sendResponse);
    await settle();

    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: "source_tab_not_confirmed" });
    expect(fake.browser.created).toEqual([]);
  });

  it("answers with the failure, not silence, when the browser cannot open the tab", async () => {
    const fake = installFakeChrome();
    fake.session()["tpd:tabContexts"] = {
      42: { tabId: 42, state: "confirmed", ownerThreadsUserId: ALICE_ID, ownerUsername: "alice", documentId: "doc-1" },
    };
    fake.browser.failCreate = true;
    await import("../../src/background/serviceWorker");

    const sendResponse = vi.fn();
    fake.dispatchMessage({ type: OPEN_DASHBOARD_MESSAGE_TYPE, sourceTabId: 42 }, {} as chrome.runtime.MessageSender, sendResponse);
    await settle();

    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: expect.stringContaining("could not open") });
  });

  it("does not answer a request that names no source tab", async () => {
    const fake = installFakeChrome();
    await import("../../src/background/serviceWorker");

    const sendResponse = vi.fn();
    const kept = fake.dispatchMessage({ type: OPEN_DASHBOARD_MESSAGE_TYPE, sourceTabId: "42" }, {} as chrome.runtime.MessageSender, sendResponse);
    await settle();

    expect(kept).toBeUndefined();
    expect(sendResponse).not.toHaveBeenCalled();
  });
});

/**
 * The reload path end to end: the worker's tab handling and a REAL `ThreadsAccountResolver` in the new document,
 * not a hand-written report sequence. A reload ends the Dashboard; the new page's proof neither revives it nor
 * waits on it.
 */
describe("background + resolver: a reload ends the Dashboard for good", () => {
  function bootstrapWith(viewer: unknown): string {
    const payload = JSON.stringify({
      require: [["ScheduledServerJS", "handle", null, [{ __bbox: { define: [["BarcelonaSharedData", [], { viewer }, 1]] } }]]],
    });
    return `<script type="application/json" data-sjs>${payload}</script>`;
  }

  /** The production path: the new document's own resolver, reporting through the same runtime message the worker listens to. */
  function startResolverAsTab42Document(fake: Fake, documentId: string, resolveCachedUsername: (username: string) => Promise<string | null> = async () => null) {
    return new ThreadsAccountResolver(document, {
      resolveCachedUsername,
      report: (state) => fake.dispatchMessage({ type: REPORT_ACCOUNT_CONTEXT_MESSAGE_TYPE, ...state }, fromTab(42, documentId), () => {}),
    });
  }

  it("the same account confirming again in the reloaded page opens no way back into the old session", async () => {
    const fake = installFakeChrome();
    seedAliceWithDashboard(fake);
    await import("../../src/background/serviceWorker");

    // 1. The reload commits: the old document is gone.
    fake.browser.liveDocuments.delete("doc-1");
    fake.dispatchTabUpdated(42, { status: "loading", tabUrl: THREADS });
    await settle();
    expect(sessionsOf(fake)["session-1"].state).toBe("invalid");

    // 2. The new page proves Alice again.
    document.body.innerHTML = bootstrapWith({ id: ALICE_ID, username: "alice" });
    const resolver = startResolverAsTab42Document(fake, "doc-2");
    resolver.start();
    await settle();
    resolver.stop();

    expect(sessionsOf(fake)["session-1"].state).toBe("invalid");
    expect(contextOf(fake, 42)).toMatchObject({ state: "confirmed", ownerThreadsUserId: ALICE_ID, documentId: "doc-2" });
    // Nothing ever flickered active again after the reload began.
    const writes = fake.sessionWrites().map((write) => Object.values((write["tpd:dashboardSessions"] as Record<string, { state?: string }>) ?? {}));
    expect(writes.flat().filter((session) => session.state === "active")).toEqual([]);
    document.body.replaceChildren();
  });

  /**
   * Logout, as OBSERVED on a live session (review round 6, High #3): signing out replaces the document, and the
   * replacement ships BarcelonaSharedData with viewer: null.
   */
  it("after a logout the replacement page reports itself unresolved, and its stale nav anchor confirms nobody", async () => {
    const fake = installFakeChrome();
    seedAliceWithDashboard(fake);
    await import("../../src/background/serviceWorker");
    fake.browser.liveDocuments.delete("doc-1");

    fake.dispatchTabUpdated(42, { status: "loading", tabUrl: "https://www.threads.com/login" });
    await settle();
    document.body.innerHTML = `${bootstrapWith(null)}<nav><a href="/@alice">alice</a></nav>`;
    // Alice's username is still in identityCache - she was signed in a second ago - so the pre-fix fallback had
    // everything it needed to re-confirm her from that dead nav bar.
    const resolver = startResolverAsTab42Document(fake, "doc-2", async () => ALICE_ID);
    resolver.start();
    await settle();
    resolver.stop();

    expect(sessionsOf(fake)["session-1"].state).toBe("invalid");
    expect(contextOf(fake, 42)).toMatchObject({ state: "unresolved", documentId: "doc-2" });
    document.body.replaceChildren();
  });

  it("DL12: the old page's confirmation arriving after the new page's neither revives the Dashboard nor unseats the new account", async () => {
    const fake = installFakeChrome();
    seedAliceWithDashboard(fake);
    await import("../../src/background/serviceWorker");
    fake.browser.liveDocuments.delete("doc-1");
    fake.dispatchTabUpdated(42, { status: "loading", tabUrl: THREADS });
    await settle();

    const bob = { type: REPORT_ACCOUNT_CONTEXT_MESSAGE_TYPE, state: "confirmed", ownerThreadsUserId: "456", ownerUsername: "bob" };
    fake.dispatchMessage(bob, fromTab(42, "doc-2"), () => {});
    await settle();
    const lateAlice = { type: REPORT_ACCOUNT_CONTEXT_MESSAGE_TYPE, state: "confirmed", ownerThreadsUserId: ALICE_ID, ownerUsername: "alice" };
    fake.dispatchMessage(lateAlice, fromTab(42, "doc-1"), () => {});
    await settle();

    expect(sessionsOf(fake)["session-1"].state).toBe("invalid");
    expect(contextOf(fake, 42)).toMatchObject({ state: "confirmed", ownerThreadsUserId: "456", documentId: "doc-2" });
  });
});

describe("background service worker: diagnostics coordinator (Phase 4 review of Tasks 3-9)", () => {
  const event = (n: number) => ({
    code: "STORAGE_VALIDATION_FAILED",
    component: "storage",
    occurredAt: new Date(Date.UTC(2026, 8, 19, 0, 0, n)).toISOString(),
    extensionVersion: "1.0.0",
  });

  /** The worker fake's storage is inert; the coordinator needs one that actually stores. */
  function withRealStorage(fake: ReturnType<typeof installFakeChrome>) {
    const storage = installFakeChromeStorage();
    (globalThis as unknown as { chrome: { storage: { local: unknown } } }).chrome.storage.local = storage;
    return { fake, storage };
  }

  it("answers another context's append, and keeps the channel open for the async reply", async () => {
    const { fake, storage } = withRealStorage(installFakeChrome());
    await import("../../src/background/serviceWorker");

    const sendResponse = vi.fn();
    const kept = fake.dispatchMessage(
      { type: "tpd:diagnostic-append", event: event(1), skipRepeat: false },
      { tab: { id: 7 } } as chrome.runtime.MessageSender,
      sendResponse,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(kept).toBe(true);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    expect(storage.snapshot().diagnostics).toEqual([event(1)]);
  });

  it("answers a clear, and refuses an event outside the taxonomy", async () => {
    const { fake, storage } = withRealStorage(installFakeChrome());
    await import("../../src/background/serviceWorker");
    await storage.set({ diagnostics: [event(1)] });

    const refused = vi.fn();
    fake.dispatchMessage(
      { type: "tpd:diagnostic-append", event: { ...event(2), code: "NOT_A_CODE" }, skipRepeat: false },
      {} as chrome.runtime.MessageSender,
      refused,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(refused).toHaveBeenCalledWith({ ok: false });
    expect(storage.snapshot().diagnostics).toEqual([event(1)]);

    const cleared = vi.fn();
    fake.dispatchMessage({ type: "tpd:diagnostic-clear" }, {} as chrome.runtime.MessageSender, cleared);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cleared).toHaveBeenCalledWith({ ok: true });
    expect(Object.hasOwn(storage.snapshot(), "diagnostics")).toBe(false);
  });

  it("records its own diagnostics directly - a service worker cannot message itself, and its sendMessage reaches nobody", async () => {
    const { storage } = withRealStorage(installFakeChrome());
    await import("../../src/background/serviceWorker");
    const { LocalDiagnosticStore } = await import("../../src/diagnostics/DiagnosticStore");

    await new LocalDiagnosticStore().record(event(1) as never);

    // The fake worker's runtime.sendMessage answers only the migration coordinator; the event got in another way.
    expect(storage.snapshot().diagnostics).toEqual([event(1)]);
  });
});

describe("background service worker: surface health relay (Phase 4 Task 22)", () => {
  const KEY = "tpd:tabSurfaces";
  const PROFILE_DEGRADED = { profile: "degraded", "post-author": "ready" };
  const fromThreads = (tabId: number) => ({ tab: { id: tabId }, url: "https://www.threads.com/@alice" }) as chrome.runtime.MessageSender;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  async function report(fake: ReturnType<typeof installFakeChrome>, tabId: number, surfaces: unknown = PROFILE_DEGRADED) {
    const sendResponse = vi.fn();
    const kept = fake.dispatchMessage({ type: "tpd:report-surface-health", surfaces }, fromThreads(tabId), sendResponse);
    await settle();
    return { kept, sendResponse };
  }

  it("stores a Threads tab's report under the tab it came from, answers, and keeps the channel open for the async reply", async () => {
    const fake = installFakeChrome();
    await import("../../src/background/serviceWorker");

    const { kept, sendResponse } = await report(fake, 42);

    expect(kept).toBe(true);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    expect(fake.session()[KEY]).toEqual({ "42": PROFILE_DEGRADED });
  });

  it("refuses a report from a page that is not Threads, and stores nothing", async () => {
    const fake = installFakeChrome();
    await import("../../src/background/serviceWorker");

    const sendResponse = vi.fn();
    fake.dispatchMessage(
      { type: "tpd:report-surface-health", surfaces: PROFILE_DEGRADED },
      { tab: { id: 42 }, url: "https://evil.example/" } as chrome.runtime.MessageSender,
      sendResponse,
    );
    await settle();

    expect(sendResponse).toHaveBeenCalledWith({ ok: false });
    expect(fake.session()).not.toHaveProperty(KEY);
  });

  it("does not answer a message that is not a surface report", async () => {
    const fake = installFakeChrome();
    await import("../../src/background/serviceWorker");

    const sendResponse = vi.fn();
    fake.dispatchMessage({ type: "tpd:something-else", surfaces: PROFILE_DEGRADED }, fromThreads(42), sendResponse);
    await settle();

    expect(sendResponse).not.toHaveBeenCalled();
    expect(fake.session()).not.toHaveProperty(KEY);
  });

  it("forgets a tab when it closes, and only that tab", async () => {
    const fake = installFakeChrome();
    await import("../../src/background/serviceWorker");
    await report(fake, 1);
    await report(fake, 2);

    fake.dispatchTabRemoved(1);
    await settle();

    expect(fake.session()[KEY]).toEqual({ "2": PROFILE_DEGRADED });
  });

  it("forgets a tab when it starts loading a page, since that page has not failed yet", async () => {
    const fake = installFakeChrome();
    await import("../../src/background/serviceWorker");
    await report(fake, 42);

    fake.dispatchTabUpdated(42, { status: "loading", tabUrl: "https://www.threads.com/@bob" });
    await settle();

    expect(fake.session()[KEY]).toEqual({});
  });

  it("keeps a tab through a status update that is not the start of a load", async () => {
    const fake = installFakeChrome();
    await import("../../src/background/serviceWorker");
    await report(fake, 42);
    const writes = fake.sessionWrites().length;

    fake.dispatchTabUpdated(42, { status: "complete", tabUrl: "https://www.threads.com/@bob" });
    await settle();

    expect(fake.session()[KEY]).toEqual({ "42": PROFILE_DEGRADED });
    expect(fake.sessionWrites()).toHaveLength(writes);
  });
});
