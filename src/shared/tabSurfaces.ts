import { anyDegraded, parseSurfaceHealth, type SurfaceHealthSnapshot } from "./surfaceHealth";
import { REPORT_SURFACE_HEALTH_MESSAGE_TYPE } from "./surfaceHealthMessage";
import { isThreadsUrl } from "./threadsUrl";

/**
 * Which Threads tabs have a degraded integration right now (Phase 4 Task 22): the answer the popup and About
 * page give when they say that part of the Threads integration is unavailable.
 *
 * `chrome.storage.session`: memory only, cleared when the browser restarts, never on disk, never in a backup,
 * never sent anywhere. Only degraded tabs are kept, so the map is empty when nothing is wrong and a tab whose
 * surfaces come back simply leaves it. What is kept is a closed-set snapshot (`surfaceHealth.ts`) keyed by tab
 * ID: no URL, username, error or message can be in it.
 *
 * Every write runs in the background service worker, one at a time (the same pattern as
 * `AccountContextRegistry`); content scripts cannot reach session storage and report through a message, and
 * the popup and the Dashboard only read.
 */
export const TAB_SURFACES_STORAGE_KEY = "tpd:tabSurfaces";

type Stored = Record<string, SurfaceHealthSnapshot>;

let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task, task);
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Whatever is stored is rebuilt: a tab ID that is not digits, a snapshot that does not parse, or one with nothing degraded is dropped. */
async function readAll(): Promise<Stored> {
  const stored = await chrome.storage.session.get(TAB_SURFACES_STORAGE_KEY);
  const raw: unknown = stored[TAB_SURFACES_STORAGE_KEY];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const rebuilt: Stored = {};
  for (const [tabId, value] of Object.entries(raw)) {
    const parsed = parseSurfaceHealth(value);
    if (/^\d+$/.test(tabId) && parsed && anyDegraded(parsed)) rebuilt[tabId] = parsed;
  }
  return rebuilt;
}

async function writeAll(all: Stored): Promise<void> {
  await chrome.storage.session.set({ [TAB_SURFACES_STORAGE_KEY]: all });
}

/** Background only. Records a tab's surfaces, or forgets the tab when nothing in it is degraded. */
export function setTabSurfaces(tabId: number, surfaces: SurfaceHealthSnapshot): Promise<void> {
  return enqueue(async () => {
    const all = await readAll();
    const key = String(tabId);
    if (anyDegraded(surfaces)) all[key] = surfaces;
    else if (Object.hasOwn(all, key)) delete all[key];
    else return; // nothing was recorded and nothing is: no write
    await writeAll(all);
  });
}

/** Background only. A tab that closed or began to navigate stops reporting anything. */
export function clearTabSurfaces(tabId: number): Promise<void> {
  return enqueue(async () => {
    const all = await readAll();
    const key = String(tabId);
    if (!Object.hasOwn(all, key)) return;
    delete all[key];
    await writeAll(all);
  });
}

/** The tab's degraded surfaces, or `undefined` when nothing is known to be wrong with it. */
export async function getTabSurfaces(tabId: number): Promise<SurfaceHealthSnapshot | undefined> {
  const all = await readAll();
  return Object.hasOwn(all, String(tabId)) ? all[String(tabId)] : undefined;
}

/** Every open tab that has a degraded surface. Empty when nothing is wrong. */
export async function getDegradedTabSurfaces(): Promise<SurfaceHealthSnapshot[]> {
  return Object.values(await readAll());
}

/** Whether a change event from `chrome.storage.onChanged` is this registry's, so a reader knows to look again. */
export const isTabSurfacesChange = (changes: Record<string, chrome.storage.StorageChange>, areaName: string): boolean =>
  areaName === "session" && Object.hasOwn(changes, TAB_SURFACES_STORAGE_KEY);

/**
 * The background's answer to a content script's report, or `undefined` for a message that is not one.
 * The tab is `sender.tab.id`, never anything the message says about itself, and only a Threads page can report:
 * a content script runs nowhere else, so a report from anywhere else is not one. What the message carries is
 * rebuilt from the closed set, and a report that does not parse is refused whole.
 */
export function handleSurfaceHealthMessage(message: unknown, sender: { tab?: { id?: number }; url?: string }): Promise<{ ok: boolean }> | undefined {
  if (typeof message !== "object" || message === null || (message as { type?: unknown }).type !== REPORT_SURFACE_HEALTH_MESSAGE_TYPE) return undefined;
  const tabId = sender.tab?.id;
  const surfaces = parseSurfaceHealth((message as { surfaces?: unknown }).surfaces);
  if (tabId === undefined || !isThreadsUrl(sender.url) || surfaces === undefined) return Promise.resolve({ ok: false });
  return setTabSurfaces(tabId, surfaces).then(
    () => ({ ok: true }),
    () => ({ ok: false }),
  );
}

/** Installed once by the background, so a closed tab never lingers in the map. */
export function installTabSurfaceCleanup(): void {
  chrome.tabs.onRemoved.addListener((tabId) => {
    void clearTabSurfaces(tabId);
  });
}

/** Test-only: the queue is module-level state that otherwise persists for the life of a context. */
export function __resetTabSurfacesQueueForTests(): void {
  queue = Promise.resolve();
}
