/**
 * Tab-scoped current-account proof (Phase 3.5 Task 14). Backed entirely by
 * `chrome.storage.session` - memory-only, cleared on browser restart, never
 * `chrome.storage.local` - so a confirmed owner is never durable state
 * ("no confirmed owner means no private Directory access" must survive a
 * restart back to unresolved, never resume from a stale last-known owner).
 *
 * Every mutation here runs only inside the background service worker (the
 * `chrome.tabs.onRemoved` cleanup listener and the account-context message
 * relay in `src/background/serviceWorker.ts` - content scripts cannot reach
 * `chrome.storage.session` directly and report through that relay instead).
 * Confined to one JS context, but background can still receive a removal
 * cleanup and a context report back-to-back before either's own
 * read-modify-write finishes; `enqueue` serializes them so the second write
 * is always built from the first's result, never a stale read racing it
 * (Phase 3.5 review round 3, High #3). Reads (`getTabContext`) stay direct,
 * including from popup - `chrome.storage.session.get` returns one atomic
 * snapshot, and no caller writes back based on what it read.
 *
 * A tab's record follows the tab's CURRENT document, and there is no grace
 * period: a record is either `confirmed` by that document or `unresolved`
 * (Dashboard source lifecycle design 2026-09-21). Each report carries the
 * browser's own `sender.documentId`, so a message from a document that has
 * since been replaced can be recognised and dropped instead of being
 * mistaken for the new page's proof.
 *
 * `reportSeq` (Codex review 2026-09-22, F3) is a monotonic per-tab counter,
 * bumped by every report this registry ACCEPTS - a confirmation, a loss of
 * proof, or the tab's current document being retired - never by one it
 * drops. This registry and the session registry that reads it are two
 * separate queues, so a session-ending decision, made from one accepted
 * report, can still be QUEUED when a second, later report for the same tab
 * finishes and rewrites this very context. Deciding from "the tab's context
 * right now" at that point would see the second report's answer and forget
 * the first report's loss of proof ever happened - reviving, in effect, a
 * Dashboard the first report already doomed. `reportSeq` is what lets
 * `src/background/dashboardLifecycle.ts` decide from a report's OWN verdict
 * instead, bounded to sessions whose `sourceReportSeq` is older than it: a
 * later report can then never erase an earlier one's accepted verdict, and
 * an earlier one, arriving late, can never end a session a later report
 * already opened.
 */
export interface ThreadsTabContext {
  tabId: number;
  state: "confirmed" | "unresolved";
  ownerThreadsUserId?: string;
  ownerUsername?: string;
  confirmedAt?: string;
  /** The document (`sender.documentId`) whose report this is. Absent only when the browser gave none (tests, very old browsers). */
  documentId?: string;
  /**
   * Documents of this tab that were replaced or left. A report still in flight from one of them proves nothing
   * about the page the tab shows now, and must neither confirm an account nor overwrite a newer document's record.
   * Kept for the tab's lifetime, including worker restarts. Evicting an old ID would make a delayed report
   * from that document look new again. Tab removal clears this history with the rest of the context.
   */
  retiredDocumentIds?: string[];
  /** See the module comment. Absent only for a context a test built directly with `setTabContext`, which reads as older than any real report (0). */
  reportSeq?: number;
}

const SESSION_KEY = "tpd:tabContexts";

let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task, task);
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function readAll(): Promise<Record<number, ThreadsTabContext>> {
  const stored = await chrome.storage.session.get(SESSION_KEY);
  return (stored[SESSION_KEY] as Record<number, ThreadsTabContext> | undefined) ?? {};
}

async function writeAll(contexts: Record<number, ThreadsTabContext>): Promise<void> {
  await chrome.storage.session.set({ [SESSION_KEY]: contexts });
}

function withRetired(retired: readonly string[] | undefined, documentId: string | undefined): string[] {
  const kept = retired ?? [];
  if (documentId === undefined || kept.includes(documentId)) return [...kept];
  return [...kept, documentId];
}

/** Only ever for a context a caller built itself (tests, or the report path below); production code goes through `recordTabReport`. */
export function setTabContext(tabId: number, context: Omit<ThreadsTabContext, "tabId">): Promise<void> {
  return enqueue(async () => {
    const all = await readAll();
    all[tabId] = { tabId, ...context };
    await writeAll(all);
  });
}

export async function getTabContext(tabId: number): Promise<ThreadsTabContext | undefined> {
  const all = await readAll();
  return all[tabId];
}

/**
 * Applies one content-script report to its tab (Dashboard source lifecycle §3/§5). Returns the tab's new
 * `reportSeq` when the report is accepted, or `undefined` when it came from a document this tab has already
 * replaced - changing nothing, so a caller can tell "nothing to reconcile" from "reconcile against seq N".
 *
 * A report from a document other than the one on record means the tab moved on to a new document; the old one
 * is retired here as well, so a late message from it cannot come back later even if nothing else noticed the
 * reload. Anything that is not a complete confirmation is recorded as `unresolved`.
 */
export function recordTabReport(
  tabId: number,
  documentId: string | undefined,
  report: { state: string; ownerThreadsUserId?: string; ownerUsername?: string },
  confirmedAt: string = new Date().toISOString(),
): Promise<number | undefined> {
  return enqueue(async () => {
    const all = await readAll();
    const existing = all[tabId];
    if (documentId !== undefined && existing?.retiredDocumentIds?.includes(documentId)) return undefined;

    const replaced = existing?.documentId !== undefined && documentId !== undefined && existing.documentId !== documentId;
    const retired = replaced ? withRetired(existing?.retiredDocumentIds, existing?.documentId) : (existing?.retiredDocumentIds ?? []);
    const confirmed = report.state === "confirmed" && report.ownerThreadsUserId && report.ownerUsername;
    const reportSeq = (existing?.reportSeq ?? 0) + 1;
    all[tabId] = {
      tabId,
      state: confirmed ? "confirmed" : "unresolved",
      ...(confirmed ? { ownerThreadsUserId: report.ownerThreadsUserId, ownerUsername: report.ownerUsername, confirmedAt } : {}),
      ...(documentId === undefined ? {} : { documentId }),
      ...(retired.length > 0 ? { retiredDocumentIds: retired } : {}),
      reportSeq,
    };
    await writeAll(all);
    return reportSeq;
  });
}

/**
 * The tab's document `documentId` was replaced or left: it stops proving anything, and nothing it still has in
 * flight is believed. A tab with no record yet gets one holding only that id: the page can leave before its first
 * report lands, and that report must then be dropped like any other late one (Codex Security scan 092502).
 *
 * Returns the tab's new `reportSeq` only when `documentId` really was the current one - the caller then has
 * something to end. If a NEWER document has already reported, this only appends the old id to
 * `retiredDocumentIds` and returns `undefined`: nothing about the tab's CURRENT proof changed, so there is
 * nothing to reconcile here. Whatever needed ending because of that newer document already ended when IT was
 * recorded (`recordTabReport`'s own `replaced` handling) - a late retirement of the document it replaced must
 * not get a second, independent say over sessions that report has already settled.
 */
export function retireTabDocument(tabId: number, documentId: string | undefined): Promise<number | undefined> {
  return enqueue(async () => {
    const all = await readAll();
    const existing = all[tabId];
    if (!existing) {
      if (documentId === undefined) return undefined;
      all[tabId] = { tabId, state: "unresolved", retiredDocumentIds: [documentId] };
      await writeAll(all);
      return undefined;
    }
    const retired = withRetired(existing.retiredDocumentIds, documentId);
    const isCurrent = existing.documentId === documentId;
    if (!isCurrent) {
      all[tabId] = { ...existing, ...(retired.length > 0 ? { retiredDocumentIds: retired } : {}) };
      await writeAll(all);
      return undefined;
    }
    const reportSeq = (existing.reportSeq ?? 0) + 1;
    all[tabId] = { tabId, state: "unresolved", ...(retired.length > 0 ? { retiredDocumentIds: retired } : {}), reportSeq };
    await writeAll(all);
    return reportSeq;
  });
}

/** Called when a tab closes - it stops proving anything. */
export function clearTabContext(tabId: number): Promise<void> {
  return enqueue(async () => {
    const all = await readAll();
    if (!(tabId in all)) return;
    delete all[tabId];
    await writeAll(all);
  });
}

/** Installed once by the background service worker so a closed tab's context never lingers. */
export function installTabRemovalCleanup(): void {
  chrome.tabs.onRemoved.addListener((tabId) => {
    void clearTabContext(tabId);
  });
}

/** Test-only: `chrome.storage.session` state otherwise persists for the life of a context. */
export async function __clearAllTabContextsForTests(): Promise<void> {
  await writeAll({});
}

/** Test-only: the queue is module-level state that otherwise persists for the life of a context (by design) or a test file (not by design). */
export function __resetAccountContextRegistryQueueForTests(): void {
  queue = Promise.resolve();
}
