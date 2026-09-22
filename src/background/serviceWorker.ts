import { installTabRemovalCleanup } from "../account/AccountContextRegistry";
import { OPEN_DASHBOARD_MESSAGE_TYPE, type OpenDashboardMessage } from "../account/dashboardSessionRequest";
import { REPORT_ACCOUNT_CONTEXT_MESSAGE_TYPE, type ReportAccountContextMessage } from "../account/reportAccountContext";
import { SOURCE_UNLOADING_MESSAGE_TYPE } from "../account/sourceDocumentLifecycle";
import { installDiagnosticCoordinator } from "../diagnostics/diagnosticCoordinator";
import { clearTabSurfaces, handleSurfaceHealthMessage, installTabSurfaceCleanup } from "../shared/tabSurfaces";
import { installDirectoryLockArbiter } from "../storage/directoryLock";
import { performMigrationOnce, STORAGE_MIGRATION_MESSAGE_TYPE } from "../storage/migrations";
import {
  handleSourceReport,
  handleSourceUnloading,
  handleTabLoading,
  handleTabRemoved,
  openDashboard,
} from "./dashboardLifecycle";

chrome.runtime.onInstalled.addListener(() => undefined);

// Closed tabs must never keep proving an owner (Phase 3.5 Task 14).
installTabRemovalCleanup();

// ...nor keep a warning that part of the Threads integration is unavailable (Phase 4 Task 22).
installTabSurfaceCleanup();

// The one cross-context serialization point for every Directory mutation (Phase 3.5 review round 3, High #4).
installDirectoryLockArbiter();

// The one place the diagnostics buffer is written; every other context sends here (Phase 4 review of Tasks 3-9, Medium 2).
installDiagnosticCoordinator();

// A closed source tab ends every Dashboard it opened; a closed Dashboard ends only its own session (Dashboard source lifecycle §3).
chrome.tabs.onRemoved.addListener((tabId) => {
  void handleTabRemoved(tabId).catch(() => undefined);
});

/**
 * `status: "loading"` is what a full reload, a navigation to another origin, AND an in-page navigation
 * (`pushState`, a hash change) all look like to `tabs.onUpdated`, and it arrives when a new document commits,
 * not when navigating starts. So this only asks `handleTabLoading` whether the source's own document is still
 * there; the start of a navigation is caught earlier, by the page's `beforeunload` message below. See
 * `src/account/sourceDocumentLifecycle.ts` for what was measured.
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "loading") return;
  // A page that is loading has not failed yet: its content script reports afresh if it does.
  void clearTabSurfaces(tabId);
  void handleTabLoading(tabId, tab.url).catch(() => undefined);
});

/** A message from the top-level page of a tab: the tab id and document id come from the browser, never from the message. */
function topLevelSource(sender: chrome.runtime.MessageSender): { tabId: number; documentId: string | undefined } | null {
  if (sender.tab?.id === undefined || (sender.frameId !== undefined && sender.frameId !== 0)) return null;
  return { tabId: sender.tab.id, documentId: sender.documentId };
}

/**
 * Content scripts cannot reach `chrome.storage.session` directly (untrusted
 * context by default), so a tab reports its own resolution state here - the
 * background reads the reporting tab's id from `sender.tab.id` rather than
 * trusting a tabId the message itself could claim to be.
 */
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  const source = topLevelSource(sender);
  if (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === REPORT_ACCOUNT_CONTEXT_MESSAGE_TYPE &&
    source
  ) {
    handleSourceReport(source.tabId, source.documentId, message as ReportAccountContextMessage)
      .then(() => sendResponse({ ok: true }))
      .catch((error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true; // keep the message channel open for the async sendResponse
  }
  return undefined;
});

/** A source page announcing that it is being navigated away from or reloaded (`beforeunload`). */
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  const source = topLevelSource(sender);
  if (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === SOURCE_UNLOADING_MESSAGE_TYPE &&
    source
  ) {
    handleSourceUnloading(source.tabId, source.documentId)
      .then(() => sendResponse({ ok: true }))
      .catch((error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true; // keep the message channel open for the async sendResponse
  }
  return undefined;
});

/**
 * Which surfaces of a Threads page are degraded (Phase 4 Task 22): the tab is `sender.tab.id`, only a Threads
 * page can report, and the report is rebuilt from the closed set before anything is stored.
 */
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  const handled = handleSurfaceHealthMessage(message, sender);
  if (!handled) return undefined;
  void handled.then(sendResponse);
  return true; // keep the message channel open for the async sendResponse
});

/**
 * The single authority for opening a Dashboard (Phase 3.5 Task 19, review round 3 High #3; a fixed source per
 * Dashboard since the 2026-09-21 lifecycle design) - popup sends only a `sourceTabId`, never an owner (review
 * round 4, High #3): background derives the owner itself, from that tab's OWN confirmed context read fresh
 * inside the same locked transaction that opens the tab, so neither a forged caller-declared owner nor a stale
 * one (the tab may have stopped being confirmed between popup's own read and this message landing) can ever
 * reach the registry.
 */
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === OPEN_DASHBOARD_MESSAGE_TYPE &&
    typeof (message as { sourceTabId?: unknown }).sourceTabId === "number"
  ) {
    const request = message as OpenDashboardMessage;
    openDashboard(request.sourceTabId)
      .then((result) => sendResponse(result))
      .catch((error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true; // keep the message channel open for the async sendResponse
  }
  return undefined;
});

/**
 * The single coordinator every other extension context routes the one-time
 * V1/V2 -> V3 migration through (Phase 3 review round 2, P1), so two
 * contexts racing the first migration converge on one attempt and one
 * `directoryId` instead of each performing (and persisting) their own.
 *
 * Replies with completion status only, never the migrated storage itself
 * (Phase 3 review round 3, High #1) - `loadAndMigrateStorage` always
 * re-reads storage itself once it sees `ok: true`, which is what lets a
 * caller whose message round-trip lands after a sibling context's own
 * write still see that write, instead of the snapshot frozen at whatever
 * moment this coordinator's own migration happened to resolve.
 */
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === STORAGE_MIGRATION_MESSAGE_TYPE
  ) {
    performMigrationOnce()
      .then(() => sendResponse({ ok: true }))
      .catch((error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true; // keep the message channel open for the async sendResponse
  }
  return undefined;
});
