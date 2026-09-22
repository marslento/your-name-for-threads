import { getTabContext, recordTabReport, retireTabDocument } from "../account/AccountContextRegistry";
import {
  invalidateSessions,
  newSession,
  transactSessions,
  type DashboardAccountSession,
} from "../account/DashboardSessionRegistry";
import { SOURCE_PING_MESSAGE_TYPE } from "../account/sourceDocumentLifecycle";
import { isThreadsUrl } from "../shared/threadsUrl";

/**
 * The one place a Dashboard's life is decided (Dashboard source lifecycle design 2026-09-21). A Dashboard belongs
 * to the Threads tab - and the exact document in it - that proved its account when the popup opened it. When that
 * source reloads, leaves Threads, closes, or stops proving the same account, the session ends first (durably,
 * in `chrome.storage.session`, which every open Dashboard hears at once and answers by locking), and only then is
 * the Dashboard's own tab closed. Closing is a courtesy: a Dashboard that stays open after a failed close is
 * locked, and nothing here decides anything by whether a window is still on screen.
 *
 * Everything an event needs is read from `chrome.storage.session`, never from worker memory, so a worker that
 * was stopped and restarted by the very event that woke it still knows what to end.
 */

const DASHBOARD_PAGE = "dashboard.html";
/** Longer than a live page needs to answer, short enough that a page which cannot is treated as gone. */
const PING_TIMEOUT_MS = 1_500;

export type OpenDashboardResult = { ok: true; sessionId: string } | { ok: false; error: "source_tab_not_confirmed" };

function dashboardUrl(sessionId: string): string {
  return `${chrome.runtime.getURL(DASHBOARD_PAGE)}?session=${sessionId}`;
}

/**
 * Whether the browser tab still shows THIS session's Dashboard. `chrome.runtime.getContexts` reports the
 * extension's own pages with no extra permission; a tab the person has since sent to another site reports
 * nothing, which is what stops a close (or a focus) from landing on an unrelated page that inherited the id.
 */
async function showsSession(tabId: number, sessionId: string): Promise<boolean> {
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["TAB"], tabIds: [tabId] });
    return contexts.some((context) => context.documentUrl?.split("#")[0] === dashboardUrl(sessionId));
  } catch {
    return false;
  }
}

/** Closes only a tab verified to be the Dashboard the ended session opened. Never throws: the session is already ended. */
async function closeDashboards(sessions: readonly DashboardAccountSession[]): Promise<void> {
  for (const session of sessions) {
    if (session.dashboardTabId === undefined) continue;
    try {
      if (await showsSession(session.dashboardTabId, session.sessionId)) await chrome.tabs.remove(session.dashboardTabId);
    } catch {
      // Already closed, or the browser refused; the session stays ended either way.
    }
  }
}

/** Brings an existing Dashboard forward. `false` when its tab is gone or no longer shows it. */
async function focusDashboard(session: DashboardAccountSession): Promise<boolean> {
  if (session.dashboardTabId === undefined) return false;
  try {
    const tab = await chrome.tabs.get(session.dashboardTabId);
    // A tab that is still loading has no page to ask yet - it is the one just opened, so trust it.
    if (tab.status === "complete" && !(await showsSession(session.dashboardTabId, session.sessionId))) return false;
    await chrome.tabs.update(session.dashboardTabId, { active: true });
    if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a report/event's own verdict supports a given session: the same owner and, if the session names a
 * document, that same document. `null` (unloading, leaving Threads, an explicit non-confirmation) supports
 * nothing. Shared by every event that ends sessions from ITS OWN verdict (see `endSessionsSupersededBy`) -
 * never "the tab's context right now", which a later event's report could have already overwritten.
 */
function supportsSession(
  verdict: { ownerThreadsUserId: string; documentId: string | undefined } | null,
  session: DashboardAccountSession,
): boolean {
  return (
    verdict !== null &&
    verdict.ownerThreadsUserId === session.ownerThreadsUserId &&
    (session.sourceDocumentId === undefined || verdict.documentId === undefined || session.sourceDocumentId === verdict.documentId)
  );
}

/**
 * Ends every ACTIVE session on `tabId` whose `sourceReportSeq` is OLDER than `seq` and that `isSupported`
 * rejects, then closes their Dashboards.
 *
 * `seq` is the sequence `AccountContextRegistry` assigned to the report or retirement that is calling this
 * (Codex review 2026-09-22, F3): a monotonic per-tab counter, so a session's own `sourceReportSeq` says exactly
 * which reports it has already accounted for. Comparing SEQUENCES, never "the tab's context right now", is what
 * lets an accepted verdict survive later events on the same tab: `AccountContextRegistry` and the session
 * registry are two separate queues, so this call's own turn can still be waiting when a LATER report for the
 * same tab finishes and overwrites the context a live-context check would otherwise read - erasing the very
 * loss of proof this call exists to act on (an earlier version of this code worked that way, and Codex found it
 * in review). Bounding by `seq` instead means a report only ever judges sessions that predate it: it can never
 * be undone by a still-later report (`invalidateSessions` never revives a session already ended), and it can
 * never end a session a later report already opened - that session's `sourceReportSeq` is not older than `seq`,
 * so it is never even considered.
 */
async function endSessionsSupersededBy(
  tabId: number,
  seq: number,
  isSupported: (session: DashboardAccountSession) => boolean,
): Promise<void> {
  const ended = await transactSessions(async (transaction) => {
    const picked = invalidateSessions(
      transaction.sessions,
      (session) => session.sourceTabId === tabId && (session.sourceReportSeq ?? 0) < seq && !isSupported(session),
    );
    if (picked.length > 0) await transaction.save();
    return picked;
  });
  await closeDashboards(ended);
}

/**
 * The popup's "Open Dashboard": one Dashboard per source tab, opened (or brought forward) by the background so it
 * knows the tab and can close it later. The owner is derived here, from the tab's own confirmed record read
 * inside the same locked transaction, never from anything the caller says. The whole decision - reuse, replace,
 * create the tab, register it - runs under the session lock, so two clicks at once cannot each open one, and a
 * source that dies halfway is ended right behind the registration instead of leaving an orphan behind.
 */
export function openDashboard(sourceTabId: number): Promise<OpenDashboardResult> {
  return transactSessions(async (transaction): Promise<OpenDashboardResult> => {
    const context = await getTabContext(sourceTabId);
    if (context?.state !== "confirmed" || !context.ownerThreadsUserId || !context.ownerUsername) {
      return { ok: false, error: "source_tab_not_confirmed" };
    }
    const { ownerThreadsUserId, ownerUsername, documentId } = context;

    const sameSource = (session: DashboardAccountSession) =>
      session.sourceTabId === sourceTabId && session.ownerThreadsUserId === ownerThreadsUserId && session.sourceDocumentId === documentId;
    let session = Object.values(transaction.sessions).find((candidate) => candidate.state === "active" && sameSource(candidate));
    if (session && (await focusDashboard(session))) return { ok: true, sessionId: session.sessionId };

    // Whatever this tab still had open is not this source (another account or document) or has lost its window.
    const replaced = invalidateSessions(transaction.sessions, (candidate) => candidate.sourceTabId === sourceTabId);
    if (replaced.length > 0) {
      await transaction.save();
      await closeDashboards(replaced);
    }

    session = newSession({
      ownerThreadsUserId,
      ownerUsername,
      sourceTabId,
      sourceReportSeq: context.reportSeq ?? 0,
      ...(documentId === undefined ? {} : { sourceDocumentId: documentId }),
    });
    transaction.sessions[session.sessionId] = session;
    await transaction.save(); // the page must never load ahead of its own session

    try {
      const tab = await chrome.tabs.create({ url: `${dashboardUrl(session.sessionId)}#/directory` });
      if (tab.id === undefined) throw new Error("The browser opened a Dashboard tab with no id.");
      transaction.sessions[session.sessionId] = { ...session, dashboardTabId: tab.id };
      await transaction.save();
    } catch (error) {
      transaction.sessions[session.sessionId] = { ...session, state: "invalid" };
      await transaction.save();
      throw error;
    }
    return { ok: true, sessionId: session.sessionId };
  });
}

/**
 * A Threads page's report of what it can prove. The tab's record is updated first (a report from a document the
 * tab has already replaced is dropped whole - it neither restores an old Dashboard nor overwrites the new page),
 * then every session on this tab that THIS report does not support ends: a different account, no account, or a
 * different document than the one the session was opened from. A report that agrees with a session changes
 * nothing about it - and never brings an ended one back.
 */
export async function handleSourceReport(
  tabId: number,
  documentId: string | undefined,
  report: { state: string; ownerThreadsUserId?: string; ownerUsername?: string },
): Promise<void> {
  const seq = await recordTabReport(tabId, documentId, report);
  if (seq === undefined) return;
  const owner = report.state === "confirmed" && report.ownerUsername ? report.ownerThreadsUserId : undefined;
  const verdict = owner !== undefined ? { ownerThreadsUserId: owner, documentId } : null;
  await endSessionsSupersededBy(tabId, seq, (session) => supportsSession(verdict, session));
}

/**
 * The source page says it is being navigated away from or reloaded (`beforeunload`). That document stops proving
 * anything at once, without waiting for the browser to say the new page has arrived: its proof is retired, so
 * every session opened from it ends and no new one can be opened from it - a Dashboard opened now, while the
 * reload is still on the network, would be the old page's authority outliving the reload it is part of. What the
 * old page says afterwards is not believed either.
 *
 * `beforeunload` is not proof that the page is leaving: the person can cancel the navigation. Nothing here waits
 * to find out, because there is nothing to find out with: re-reading the same page is not new evidence (design
 * section 4), so a cancelled navigation is recovered the way a completed one is, by a document that proves the
 * account again - a reload. The safe way round costs that reload, and never a write from a page on its way out.
 */
export async function handleSourceUnloading(tabId: number, documentId: string | undefined): Promise<void> {
  const seq = await retireTabDocument(tabId, documentId);
  if (seq === undefined) return;
  await endSessionsSupersededBy(tabId, seq, () => false);
}

async function sourceStillAnswers(tabId: number, documentId: string | undefined): Promise<boolean> {
  if (documentId === undefined) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer: unknown = await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: SOURCE_PING_MESSAGE_TYPE }, { documentId }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("The source page did not answer.")), PING_TIMEOUT_MS);
      }),
    ]);
    return (answer as { alive?: unknown } | undefined)?.alive === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `tabs.onUpdated` said `loading` for a tab. That is also what `pushState`, a hash change and `replaceState`
 * look like, so it only means "the source is gone" when
 *
 * - the URL is not a readable Threads URL: a Threads URL is always visible to this extension, so a withheld or
 *   foreign one means the tab left Threads (docs/release/permission-audit.md); or
 * - the document that proved the account no longer answers: it was replaced by a reload or a full navigation.
 *
 * Only a tab that has proof is looked at; a page that never proved anyone has nothing to lose.
 */
export async function handleTabLoading(tabId: number, tabUrl: string | undefined): Promise<void> {
  const context = await getTabContext(tabId);
  if (context?.state !== "confirmed") return;
  if (isThreadsUrl(tabUrl) && (await sourceStillAnswers(tabId, context.documentId))) return;

  // Retiring names only the document that was found gone. A page that committed while this was asking has proved
  // nothing yet, but what it has since proved stands: `retireTabDocument` returns no seq when that already
  // happened (it is no longer the tab's current document), so nothing here disturbs it.
  const seq = await retireTabDocument(tabId, context.documentId);
  if (seq === undefined) return;
  await endSessionsSupersededBy(tabId, seq, () => false);
}

/**
 * A tab closed. As a source it ends every Dashboard it opened. As a Dashboard it ends only its own session: the
 * person closed the window, so the session goes and nothing else does - the source, the Directory and the other
 * Dashboards are untouched, and a new one can be opened from the popup while the source still proves the account.
 */
export async function handleTabRemoved(tabId: number): Promise<void> {
  const ended = await transactSessions(async (transaction) => {
    const picked = invalidateSessions(transaction.sessions, (session) => session.sourceTabId === tabId);
    let changed = picked.length > 0;
    for (const session of Object.values(transaction.sessions)) {
      if (session.dashboardTabId !== tabId) continue;
      delete transaction.sessions[session.sessionId];
      changed = true;
    }
    if (changed) await transaction.save();
    return picked;
  });
  await closeDashboards(ended);
}
