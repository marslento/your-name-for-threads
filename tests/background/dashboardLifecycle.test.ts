import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetAccountContextRegistryQueueForTests,
  getTabContext,
  recordTabReport,
} from "../../src/account/AccountContextRegistry";
import {
  __resetDashboardSessionRegistryQueueForTests,
  DASHBOARD_SESSIONS_STORAGE_KEY,
  type DashboardAccountSession,
} from "../../src/account/DashboardSessionRegistry";
import {
  handleSourceReport,
  handleSourceUnloading,
  handleTabLoading,
  handleTabRemoved,
  openDashboard,
  type OpenDashboardResult,
} from "../../src/background/dashboardLifecycle";
import { installFakeDashboardBrowser, type FakeDashboardBrowser } from "../fixtures/storage/fakeDashboardBrowser";

const ALICE = { state: "confirmed", ownerThreadsUserId: "123", ownerUsername: "alice" } as const;
const BOB = { state: "confirmed", ownerThreadsUserId: "456", ownerUsername: "bob" } as const;
const THREADS = "https://www.threads.com/@alice";

let fake: FakeDashboardBrowser;

beforeEach(() => {
  fake = installFakeDashboardBrowser();
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(globalThis, "chrome");
  __resetAccountContextRegistryQueueForTests();
  __resetDashboardSessionRegistryQueueForTests();
});

const sessions = () => (fake.session[DASHBOARD_SESSIONS_STORAGE_KEY] ?? {}) as Record<string, DashboardAccountSession>;
const sessionOf = (result: OpenDashboardResult): DashboardAccountSession => {
  if (!result.ok) throw new Error(`expected a session, got ${result.error}`);
  return sessions()[result.sessionId];
};
const active = () => Object.values(sessions()).filter((session) => session.state === "active");

/** A Threads tab whose document proved `who`, still alive to answer pings. */
async function confirmedSource(tabId: number, documentId: string, who: typeof ALICE | typeof BOB = ALICE) {
  await recordTabReport(tabId, documentId, who);
  fake.liveDocuments.add(documentId);
}

/** Opens a Dashboard from `tabId` and returns its session (asserting it opened). */
async function open(tabId: number) {
  const result = await openDashboard(tabId);
  return sessionOf(result);
}

describe("openDashboard", () => {
  it("refuses a tab that has no proof, and opens nothing", async () => {
    await expect(openDashboard(1)).resolves.toEqual({ ok: false, error: "source_tab_not_confirmed" });

    await recordTabReport(1, "doc-1", { state: "unresolved" });
    await expect(openDashboard(1)).resolves.toEqual({ ok: false, error: "source_tab_not_confirmed" });
    expect(fake.created).toEqual([]);
    expect(sessions()).toEqual({});
  });

  it("binds the session to the source tab, its document and its account, and registers the tab it opens", async () => {
    await confirmedSource(1, "doc-1");

    const session = await open(1);

    expect(session).toMatchObject({
      ownerThreadsUserId: "123",
      ownerUsername: "alice",
      sourceTabId: 1,
      sourceDocumentId: "doc-1",
      state: "active",
      dashboardTabId: fake.created[0],
    });
    expect(fake.tabs.get(fake.created[0])?.url).toBe(`chrome-extension://fake-extension-id/dashboard.html?session=${session.sessionId}#/directory`);
  });

  it("has the session in storage BEFORE the browser tab that reads it exists", async () => {
    await confirmedSource(1, "doc-1");
    let visibleToThePage: DashboardAccountSession[] = [];
    fake.beforeCreate = async () => {
      visibleToThePage = active();
    };

    await open(1);

    expect(visibleToThePage).toHaveLength(1);
    expect(visibleToThePage[0].dashboardTabId).toBeUndefined();
  });

  it("DL09: the same source pressed again brings its Dashboard forward instead of opening another", async () => {
    await confirmedSource(1, "doc-1");
    const first = await open(1);

    const second = await open(1);

    expect(second.sessionId).toBe(first.sessionId);
    expect(fake.created).toHaveLength(1);
    expect(fake.focused).toEqual([first.dashboardTabId]);
  });

  it("DL09: two presses at the same instant open exactly one Dashboard", async () => {
    await confirmedSource(1, "doc-1");

    const [a, b] = await Promise.all([openDashboard(1), openDashboard(1)]);

    expect(a).toMatchObject({ ok: true });
    expect(sessionOf(a).sessionId).toBe(sessionOf(b).sessionId);
    expect(fake.created).toHaveLength(1);
    expect(active()).toHaveLength(1);
  });

  it("DL09: a second source for the same account gets its own Dashboard and never rewrites the first", async () => {
    await confirmedSource(1, "doc-1");
    await confirmedSource(2, "doc-2");
    const first = await open(1);

    const second = await open(2);

    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second).toMatchObject({ sourceTabId: 2, sourceDocumentId: "doc-2" });
    expect(sessions()[first.sessionId]).toEqual(first);
    expect(fake.created).toHaveLength(2);
  });

  it("ends the old Dashboard and opens a new one when the tab's document is no longer the one it was opened from", async () => {
    await confirmedSource(1, "doc-1");
    const first = await open(1);
    await confirmedSource(1, "doc-2"); // the tab now proves through a different document

    const second = await open(1);

    expect(sessions()[first.sessionId].state).toBe("invalid");
    expect(fake.removeCalls).toEqual([first.dashboardTabId]);
    expect(second).toMatchObject({ sourceDocumentId: "doc-2", state: "active" });
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  it("does not put a session on top of a Dashboard tab that has gone: it ends that session and opens a fresh one", async () => {
    await confirmedSource(1, "doc-1");
    const first = await open(1);
    fake.tabs.delete(first.dashboardTabId!); // closed before the removal event was heard

    const second = await open(1);

    expect(sessions()[first.sessionId].state).toBe("invalid");
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.dashboardTabId).toBeDefined();
  });

  it("does not bring forward a tab that has been sent to another site", async () => {
    await confirmedSource(1, "doc-1");
    const first = await open(1);
    fake.navigateAway(first.dashboardTabId!);

    const second = await open(1);

    expect(second.sessionId).not.toBe(first.sessionId);
    expect(fake.focused).toEqual([]);
    expect(fake.removeCalls).not.toContain(first.dashboardTabId); // it is not ours to close any more
  });

  it("leaves no active session behind when the browser cannot open the tab", async () => {
    await confirmedSource(1, "doc-1");
    fake.failCreate = true;

    await expect(openDashboard(1)).rejects.toThrow("could not open");

    expect(active()).toEqual([]);
  });

  it("derives the owner from the tab's own record, never from the caller: a tab that now proves Bob gets Bob's session (review round 4, High #3)", async () => {
    await confirmedSource(1, "doc-1", ALICE);
    await confirmedSource(1, "doc-1", BOB); // the tab switched accounts between the popup's read and this request

    const session = await open(1);

    expect(session).toMatchObject({ ownerThreadsUserId: "456", ownerUsername: "bob" });
    expect(Object.values(sessions()).filter((candidate) => candidate.ownerThreadsUserId === "123")).toEqual([]);
  });

  it("two sources for two different accounts opened at the same instant both land - neither is dropped", async () => {
    await confirmedSource(1, "doc-1", ALICE);
    await confirmedSource(2, "doc-2", BOB);

    const [a, b] = await Promise.all([openDashboard(1), openDashboard(2)]);

    expect(sessionOf(a)).toMatchObject({ ownerThreadsUserId: "123", sourceTabId: 1, state: "active" });
    expect(sessionOf(b)).toMatchObject({ ownerThreadsUserId: "456", sourceTabId: 2, state: "active" });
    expect(fake.created).toHaveLength(2);
  });

  it("an ending racing an opening for a different source never loses the ending, or the opening", async () => {
    await confirmedSource(1, "doc-1", ALICE);
    await confirmedSource(2, "doc-2", BOB);
    const first = await open(1);

    const [, second] = await Promise.all([handleTabRemoved(1), openDashboard(2)]);

    expect(sessions()[first.sessionId].state).toBe("invalid");
    expect(sessionOf(second)).toMatchObject({ sourceTabId: 2, state: "active" });
  });

  it("does not take a Dashboard whose session id merely starts with this one for this session's", async () => {
    await confirmedSource(1, "doc-1");
    const first = await open(1);
    const tab = fake.tabs.get(first.dashboardTabId!)!;
    tab.url = tab.url.replace("#/directory", "extra#/directory"); // ?session=<id>extra#/directory is another session's address

    const second = await open(1);

    expect(second.sessionId).not.toBe(first.sessionId);
    expect(fake.focused).toEqual([]);
  });

  it("still brings a Dashboard forward when only the window cannot be focused", async () => {
    await confirmedSource(1, "doc-1");
    const first = await open(1);
    fake.failWindowsUpdate = true;

    const second = await open(1);

    expect(second.sessionId).toBe(first.sessionId);
    expect(fake.focused).toEqual([first.dashboardTabId]);
  });

  it("DL17: a source that closes while its Dashboard tab is being opened does not leave an operable Dashboard", async () => {
    await confirmedSource(1, "doc-1");
    let closeSource: Promise<void> | null = null;
    fake.beforeCreate = async () => {
      // The source dies mid-open. Its handler queues behind the open; it must not slip in before the tab is registered.
      closeSource = handleTabRemoved(1);
    };

    const result = await openDashboard(1);
    await closeSource;

    const session = sessionOf(result);
    expect(session.state).toBe("invalid");
    expect(fake.removeCalls).toEqual([session.dashboardTabId]);
    expect(fake.tabs.has(session.dashboardTabId!)).toBe(false);
    expect(active()).toEqual([]);
  });

  it("DL17: nor does it inherit an account the source proves afterwards", async () => {
    await confirmedSource(1, "doc-1");
    const first = await open(1);

    await handleSourceReport(1, "doc-2", BOB); // the tab reloads and proves Bob

    expect(sessions()[first.sessionId]).toMatchObject({ state: "invalid", ownerThreadsUserId: "123" });
    expect(active()).toEqual([]);
  });
});

describe("handleSourceReport", () => {
  // Codex review 2026-09-22, F2. The tab's record and the sessions are two queues, so a report can wait behind an open
  // that is creating a tab. Judged by what the report said (unresolved), it then ended a session that a NEWER page had
  // opened in the meantime, and the newer page's confirmation could not bring it back.
  it("F2: a report of a replaced document that was queued behind an open does not end the newer page's Dashboard", async () => {
    await confirmedSource(1, "old-document");
    await confirmedSource(2, "unrelated-document");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const creating = new Promise<void>((resolve) => { entered = resolve; });
    fake.beforeCreate = async () => { entered(); await gate; };
    const unrelatedOpen = openDashboard(2);
    await creating;
    fake.beforeCreate = null;

    const pendingOpen = openDashboard(1);
    const oldReport = handleSourceReport(1, "old-document", { state: "unresolved" });
    await vi.waitFor(async () => expect((await getTabContext(1))?.state).toBe("unresolved"));
    const newReport = handleSourceReport(1, "new-document", BOB);
    await vi.waitFor(async () => expect((await getTabContext(1))?.documentId).toBe("new-document"));
    release();
    const [, answer] = await Promise.all([unrelatedOpen, pendingOpen, oldReport, newReport]);

    const session = sessionOf(answer);
    expect(session).toMatchObject({ sourceDocumentId: "new-document", ownerThreadsUserId: "456", state: "active" });
    expect(fake.removeCalls).toEqual([]);
    expect(await getTabContext(1)).toMatchObject({ state: "confirmed", ownerThreadsUserId: "456", documentId: "new-document" });
  });

  it("F2: the same holds when the stale report names another account: it cannot end what the tab now proves", async () => {
    await confirmedSource(1, "doc-1");
    const first = await open(1);
    await recordTabReport(1, "doc-2", ALICE); // the tab has moved on and the second page proved Alice again
    const second = await open(1); // a Dashboard for the new document
    expect(second.sessionId).not.toBe(first.sessionId);

    await handleSourceReport(1, "doc-1", BOB); // the old page's late word, dropped as a retired document's

    expect(sessions()[second.sessionId].state).toBe("active");
  });

  it("F2: a stale report changes nothing, and a report that is current still ends what the tab stopped proving", async () => {
    await confirmedSource(1, "doc-1");
    const session = await open(1);

    await handleSourceReport(1, "doc-1", { state: "unresolved" }); // current: the tab has stopped proving anyone
    await handleSourceReport(1, "doc-1", { state: "unresolved" }); // asked again: nothing more to end

    expect(sessions()[session.sessionId].state).toBe("invalid");
    expect(fake.removeCalls).toEqual([session.dashboardTabId]);
  });

  it("DL05: a source that stops proving anyone ends its Dashboard, and locks before it closes", async () => {
    await confirmedSource(1, "doc-1");
    const session = await open(1);
    const order: string[] = [];
    const remove = chrome.tabs.remove.bind(chrome.tabs);
    chrome.tabs.remove = async (id: number) => {
      order.push(`close:${(sessions()[session.sessionId] ?? {}).state}`);
      return remove(id);
    };

    await handleSourceReport(1, "doc-1", { state: "unresolved" });

    expect(order).toEqual(["close:invalid"]); // the session was already ended when the tab was closed
    expect(await getTabContext(1)).toMatchObject({ state: "unresolved" });
  });

  it("DL05: a source that now proves a different account ends Alice's Dashboard and never becomes Bob's", async () => {
    await confirmedSource(1, "doc-1");
    const session = await open(1);

    await handleSourceReport(1, "doc-1", BOB);

    expect(sessions()[session.sessionId]).toMatchObject({ state: "invalid", ownerThreadsUserId: "123", sourceTabId: 1 });
    expect(active()).toEqual([]);
    expect(fake.removeCalls).toEqual([session.dashboardTabId]);
  });

  it("a repeated confirmation of the same account by the same document changes nothing", async () => {
    await confirmedSource(1, "doc-1");
    const session = await open(1);

    await handleSourceReport(1, "doc-1", ALICE);

    expect(sessions()[session.sessionId]).toEqual(session);
    expect(fake.removeCalls).toEqual([]);
  });

  it("ends a session when a different document of the same tab confirms the same account", async () => {
    await confirmedSource(1, "doc-1");
    const session = await open(1);

    await handleSourceReport(1, "doc-2", ALICE);

    expect(sessions()[session.sessionId].state).toBe("invalid");
  });

  it("DL12: a confirmation from the page that was replaced neither revives its Dashboard nor overwrites the new page's account", async () => {
    await confirmedSource(1, "doc-1");
    const session = await open(1);
    await handleSourceReport(1, "doc-2", BOB); // the reload finished and the new page proved Bob

    await handleSourceReport(1, "doc-1", ALICE); // the old page's message finally arrives

    expect(sessions()[session.sessionId].state).toBe("invalid");
    expect(await getTabContext(1)).toMatchObject({ state: "confirmed", ownerThreadsUserId: "456", documentId: "doc-2" });
  });

  it("DL13: once ended, a session never comes back when the same account is confirmed again", async () => {
    await confirmedSource(1, "doc-1");
    const old = await open(1);
    await handleSourceReport(1, "doc-1", { state: "unresolved" });
    await handleSourceReport(1, "doc-1", ALICE);

    expect(sessions()[old.sessionId].state).toBe("invalid");
    expect(active()).toEqual([]);

    const fresh = await open(1); // a new one comes from the popup

    expect(fresh.sessionId).not.toBe(old.sessionId);
    expect(fresh.state).toBe("active");
  });

  it("two sources reporting at the same instant each end only their own Dashboard, and neither report is lost", async () => {
    await confirmedSource(1, "doc-1", ALICE);
    await confirmedSource(2, "doc-2", BOB);
    const alice = await open(1);
    const bob = await open(2);

    await Promise.all([handleSourceReport(1, "doc-1", { state: "unresolved" }), handleSourceReport(2, "doc-2", BOB)]);

    expect(sessions()[alice.sessionId].state).toBe("invalid");
    expect(sessions()[bob.sessionId].state).toBe("active");
    expect(await getTabContext(1)).toMatchObject({ state: "unresolved" });
    expect(await getTabContext(2)).toMatchObject({ state: "confirmed", ownerThreadsUserId: "456" });
  });

  it("DL07/DL08: a second source for the same account is unaffected until it notices for itself", async () => {
    await confirmedSource(1, "doc-1");
    await confirmedSource(2, "doc-2");
    const first = await open(1);
    const second = await open(2);

    await handleSourceReport(1, "doc-1", { state: "unresolved" }); // only source 1 has noticed the logout

    expect(sessions()[first.sessionId].state).toBe("invalid");
    expect(sessions()[second.sessionId].state).toBe("active");
    expect(fake.removeCalls).toEqual([first.dashboardTabId]);

    fake.liveDocuments.delete("doc-2"); // source 2 now reloads
    await handleTabLoading(2, "https://www.threads.com/login");

    expect(sessions()[second.sessionId].state).toBe("invalid");
    expect(fake.removeCalls).toEqual([first.dashboardTabId, second.dashboardTabId]);
  });

  // Regression: judging sessions against "the tab's context right now", read fresh inside the session
  // transaction, treats unresolved-then-reconfirmed as if the loss of
  // proof never happened, because by the time the queued reconciliation runs, a SECOND report has already
  // overwritten the context the first one set. A held-up unrelated open is what creates the queueing window;
  // nothing here needs it to be the same open that eventually reads the tab.
  it.each(["unresolved", "different-account"] as const)(
    "F3: %s followed by a reconfirmation must still revoke the pre-existing session",
    async (kind) => {
      await confirmedSource(1, "doc-1", ALICE);
      const original = await open(1);
      await confirmedSource(2, "doc-2", ALICE);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let entered!: () => void;
      const creating = new Promise<void>((resolve) => { entered = resolve; });
      fake.beforeCreate = async () => { entered(); await gate; };
      const unrelatedOpen = openDashboard(2); // occupies the session queue while both reports below land
      await creating;
      fake.beforeCreate = null;

      const invalidating = handleSourceReport(1, "doc-1", kind === "unresolved" ? { state: "unresolved" } : BOB);
      await vi.waitFor(async () =>
        kind === "unresolved"
          ? expect((await getTabContext(1))?.state).toBe("unresolved")
          : expect((await getTabContext(1))?.ownerThreadsUserId).toBe("456"),
      );
      const reconfirming = handleSourceReport(1, "doc-1", ALICE); // the same document proves Alice again
      await vi.waitFor(async () => expect((await getTabContext(1))?.ownerThreadsUserId).toBe("123"));
      release();
      await Promise.all([unrelatedOpen, invalidating, reconfirming]);

      // DL05/DL13: an accepted loss of authority is irreversible for the session that predates it, whatever the
      // tab goes on to prove afterward - reconfirming does not undo the report that already ended it, and a new
      // session is what the popup opens next, never this one coming back.
      expect(sessions()[original.sessionId].state).toBe("invalid");
      expect(fake.removeCalls).toContain(original.dashboardTabId);
    },
  );
});

describe("handleSourceUnloading", () => {
  it("DL02: ends the Dashboard as soon as the source starts to leave, without waiting for the new page", async () => {
    await confirmedSource(1, "doc-1");
    const session = await open(1);

    await handleSourceUnloading(1, "doc-1");

    expect(sessions()[session.sessionId].state).toBe("invalid");
    expect(fake.removeCalls).toEqual([session.dashboardTabId]);
  });

  // A reload must retire the old document's proof before the replacement page arrives,
  // so a Dashboard cannot open or save using evidence from the unloading document.
  it("F1: a reload still on the network cannot open a new Dashboard from the old page's proof", async () => {
    await confirmedSource(1, "doc-1");
    await open(1);

    await handleSourceUnloading(1, "doc-1"); // the reload started; the new page has not arrived

    expect(await getTabContext(1)).toMatchObject({ state: "unresolved", retiredDocumentIds: ["doc-1"] });
    await expect(openDashboard(1)).resolves.toEqual({ ok: false, error: "source_tab_not_confirmed" });
    expect(active()).toEqual([]);
    expect(fake.created).toHaveLength(1); // no second tab was opened
  });

  it("F1: an open already waiting for the session lock when the reload starts is refused too", async () => {
    await confirmedSource(1, "doc-1");
    await confirmedSource(2, "doc-2");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const creating = new Promise<void>((resolve) => { entered = resolve; });
    fake.beforeCreate = async () => { entered(); await gate; };
    const unrelated = openDashboard(2); // holds the lock while it opens its tab
    await creating;
    fake.beforeCreate = null;
    const queued = openDashboard(1); // waits behind it

    const unloading = handleSourceUnloading(1, "doc-1"); // retires the proof at once; its sweep waits behind the same lock
    await vi.waitFor(async () => expect((await getTabContext(1))?.state).toBe("unresolved"));
    release();
    const [, answer] = await Promise.all([unrelated, queued, unloading]);

    expect(answer).toEqual({ ok: false, error: "source_tab_not_confirmed" });
    expect(active().map((session) => session.sourceTabId)).toEqual([2]);
  });

  it("F1: an open that had already read the proof is ended right behind its own registration", async () => {
    await confirmedSource(1, "doc-1");
    let unloading: Promise<void> | null = null;
    fake.beforeCreate = async () => {
      unloading = handleSourceUnloading(1, "doc-1"); // the reload starts while the Dashboard tab is being opened
    };

    const result = await openDashboard(1);
    await unloading;

    const session = sessionOf(result);
    expect(session.state).toBe("invalid");
    expect(fake.removeCalls).toEqual([session.dashboardTabId]);
    expect(active()).toEqual([]);
  });

  it("a cancelled navigation is recovered the way a completed one is: only a document that proves the account again reopens it", async () => {
    await confirmedSource(1, "doc-1");
    const first = await open(1);
    await handleSourceUnloading(1, "doc-1");

    // The navigation was cancelled, and the same page speaks again. Re-reading it is not new evidence: it is dropped.
    await expect(recordTabReport(1, "doc-1", ALICE)).resolves.toBeUndefined();
    await handleSourceReport(1, "doc-1", ALICE);
    await expect(openDashboard(1)).resolves.toEqual({ ok: false, error: "source_tab_not_confirmed" });

    await confirmedSource(1, "doc-2"); // a reload that did complete
    const fresh = await open(1);

    expect(fresh.sessionId).not.toBe(first.sessionId);
    expect(fresh).toMatchObject({ sourceDocumentId: "doc-2", state: "active" });
  });

  it("DL10: nothing of this touches an in-page navigation, which never announces an unload and keeps opening Dashboards", async () => {
    await confirmedSource(1, "doc-1");
    const first = await open(1);

    await handleTabLoading(1, "https://www.threads.com/@bob"); // pushState: the page still answers

    expect((await open(1)).sessionId).toBe(first.sessionId);
  });

  it("does not retire the current document when the announcement names a document the tab has already left", async () => {
    await confirmedSource(1, "doc-1");
    await handleSourceReport(1, "doc-2", ALICE); // the tab moved on to doc-2
    fake.liveDocuments.add("doc-2");

    await handleSourceUnloading(1, "doc-1"); // a late announcement from the old page

    expect(await getTabContext(1)).toMatchObject({ state: "confirmed", documentId: "doc-2" });
    await expect(openDashboard(1)).resolves.toMatchObject({ ok: true });
  });

  it("takes a browser that names no documents to mean the tab's current one", async () => {
    await recordTabReport(1, undefined, ALICE);
    await open(1);

    await handleSourceUnloading(1, undefined);

    await expect(openDashboard(1)).resolves.toEqual({ ok: false, error: "source_tab_not_confirmed" });
    expect(active()).toEqual([]);
  });

  it("ignores a message that names a different document of the tab", async () => {
    await confirmedSource(1, "doc-1");
    const session = await open(1);

    await handleSourceUnloading(1, "some-other-doc");

    expect(sessions()[session.sessionId].state).toBe("active");
  });
});

describe("handleTabLoading", () => {
  it("DL10: an in-page navigation (the same document still answers) keeps the Dashboard", async () => {
    await confirmedSource(1, "doc-1");
    const session = await open(1);

    // pushState, a hash change and replaceState all read as `loading` with a Threads URL.
    await handleTabLoading(1, "https://www.threads.com/@bob");
    await handleTabLoading(1, "https://www.threads.com/@bob/post/abc");

    expect(sessions()[session.sessionId]).toEqual(session);
    expect(fake.removeCalls).toEqual([]);
    expect(await getTabContext(1)).toMatchObject({ state: "confirmed", documentId: "doc-1" });
  });

  it("DL01: a reload replaces the document, so the Dashboard ends and the old page is retired", async () => {
    await confirmedSource(1, "doc-1");
    const session = await open(1);
    fake.liveDocuments.delete("doc-1"); // the old document is gone when the new one commits

    await handleTabLoading(1, THREADS);

    expect(sessions()[session.sessionId].state).toBe("invalid");
    expect(fake.removeCalls).toEqual([session.dashboardTabId]);
    expect(await getTabContext(1)).toEqual({ tabId: 1, state: "unresolved", retiredDocumentIds: ["doc-1"], reportSeq: 2 });
    await expect(recordTabReport(1, "doc-1", ALICE)).resolves.toBeUndefined();
  });

  it("DL03: a tab that has left Threads ends its Dashboard even though the destination URL is withheld", async () => {
    await confirmedSource(1, "doc-1");
    const session = await open(1);

    await handleTabLoading(1, undefined);

    expect(sessions()[session.sessionId].state).toBe("invalid");
    expect(fake.pings).toEqual([]); // nothing to ask: a Threads URL is always visible to the extension
    expect(fake.removeCalls).toEqual([session.dashboardTabId]);
  });

  it("treats a page that does not answer within the wait as gone", async () => {
    await confirmedSource(1, "doc-1");
    const session = await open(1);
    fake.hangPings = true;
    vi.useFakeTimers();

    const done = handleTabLoading(1, THREADS);
    await vi.advanceTimersByTimeAsync(1_500);
    await done;

    expect(sessions()[session.sessionId].state).toBe("invalid");
  });

  it("does not end a session already bound to a NEWER document when the older document's late check finishes", async () => {
    await confirmedSource(1, "doc-1");
    await open(1);
    fake.hangPings = true;
    vi.useFakeTimers();

    const checking = handleTabLoading(1, THREADS); // asking doc-1, which will not answer
    await vi.advanceTimersByTimeAsync(0);
    await handleSourceReport(1, "doc-2", ALICE); // meanwhile the reloaded page committed and proved Alice
    fake.liveDocuments.add("doc-2");
    const second = await open(1);
    await vi.advanceTimersByTimeAsync(1_500);
    await checking;

    expect(sessions()[second.sessionId].state).toBe("active");
    expect(await getTabContext(1)).toMatchObject({ state: "confirmed", documentId: "doc-2" });
  });

  it("treats a session opened where the browser gave no document id as ended by any loading event", async () => {
    await recordTabReport(1, undefined, ALICE);
    const session = await open(1);

    await handleTabLoading(1, THREADS);

    expect(sessions()[session.sessionId].state).toBe("invalid");
  });

  it("does nothing for a tab that never proved an account, and asks nobody", async () => {
    await handleTabLoading(9, THREADS);
    await handleTabLoading(9, undefined);

    expect(fake.pings).toEqual([]);
    expect(await getTabContext(9)).toBeUndefined();
  });
});

describe("handleTabRemoved", () => {
  it("DL04: closing the source ends only its Dashboard - the other source is not adopted", async () => {
    await confirmedSource(1, "doc-1");
    await confirmedSource(2, "doc-2");
    const first = await open(1);
    const second = await open(2);

    await handleTabRemoved(1);

    expect(sessions()[first.sessionId].state).toBe("invalid");
    expect(sessions()[second.sessionId]).toEqual(second);
    expect(fake.removeCalls).toEqual([first.dashboardTabId]);
  });

  it("DL16: closing a Dashboard ends its own session and nothing else", async () => {
    await confirmedSource(1, "doc-1");
    const first = await open(1);
    fake.tabs.delete(first.dashboardTabId!);

    await handleTabRemoved(first.dashboardTabId!);

    expect(sessions()[first.sessionId]).toBeUndefined();
    expect(await getTabContext(1)).toMatchObject({ state: "confirmed" });
    expect(fake.removeCalls).toEqual([]);

    const fresh = await open(1);
    expect(fresh.state).toBe("active");
  });

  it("DL15: never closes a tab that is no longer the Dashboard, and never throws when the close fails", async () => {
    await confirmedSource(1, "doc-1");
    await confirmedSource(2, "doc-2");
    const first = await open(1);
    const second = await open(2);
    fake.navigateAway(first.dashboardTabId!);
    fake.failRemove = true;

    await expect(handleTabRemoved(1)).resolves.toBeUndefined();
    await expect(handleTabRemoved(2)).resolves.toBeUndefined();

    expect(fake.removeCalls).toEqual([second.dashboardTabId]); // the navigated-away tab was left alone; the refused close was tried
    expect(sessions()[first.sessionId].state).toBe("invalid");
    expect(sessions()[second.sessionId].state).toBe("invalid"); // a failed close does not un-end the session
  });

  it("DL15: closes nothing, and throws nothing, when the browser cannot say what a tab shows", async () => {
    await confirmedSource(1, "doc-1");
    const session = await open(1);
    fake.failGetContexts = true;

    await expect(handleTabRemoved(1)).resolves.toBeUndefined();

    expect(sessions()[session.sessionId].state).toBe("invalid"); // still ended: closing was only ever a courtesy
    expect(fake.removeCalls).toEqual([]);
  });

  it("closing an unrelated tab changes nothing", async () => {
    await confirmedSource(1, "doc-1");
    const session = await open(1);

    await handleTabRemoved(99);

    expect(sessions()[session.sessionId]).toEqual(session);
  });
});

describe("DL14: state lives in storage, not in the worker", () => {
  it("a worker started fresh by the very event that woke it still ends the right Dashboard", async () => {
    await confirmedSource(1, "doc-1");
    const session = await open(1);

    vi.resetModules(); // the worker was stopped; everything in memory is gone, storage is not
    const revived = await import("../../src/background/dashboardLifecycle");
    await revived.handleTabRemoved(1);

    expect(sessions()[session.sessionId].state).toBe("invalid");
    expect(fake.removeCalls).toEqual([session.dashboardTabId]);
  });
});
